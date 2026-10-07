# LLM 助手方案：创建 DSL + 行情询问

- 日期：2026-10-07
- 状态：P1 已实现（`feat/llm-assistant`），待有网环境用 deepseek-flash 实测；P2 / P3 未开始
- 相关：AGENTS.md 不变量 1（LLM 不进实时路径）、2（DSL 是唯一契约）、10（鉴权）

## 1. 目标

把现在单轮的「自然语言 → DSL」（`/api/parse`）扩展成一个对话式助手，承担两类意图：

| 意图 | 例子 | 产出 |
|------|------|------|
| **创建 / 修改 Signal** | "BTC 10 秒买入超过卖出 3 倍提醒我"、"阈值改成 2 倍"、"再加个 24h 涨幅 > 5%" | 通过 `validateSpec` 的 spec 提案（不自动保存） |
| **行情询问** | "BTC 现在买盘强还是卖盘强？"、"ETH 离 24h 高点多远？"、"昨晚哪个 Signal 最吵？" | 文字回答 + 支撑它的原始数据 |

两者在同一个对话里衔接：问完行情接一句"超过现在 3 倍就提醒我"，助手用刚取到的数值作参考生成 spec。

非目标：涨跌预测、买卖建议、自动保存/启停 Signal、LLM 参与任何触发判断。

## 2. 架构

```
Web 助手页 ──POST /api/chat──▶ src/server/nl/chat.ts（工具调用循环）
                                   │
                    ┌──────────────┼────────────────────┐
                    ▼              ▼                    ▼
           只读查询工具        draft_signal          Binance REST
        (runtime / db 快照)   (复用 parse.ts         (仅未订阅交易对
                              校验修复 + 规则兜底)    的 24h / K 线)
```

约束：

- `chat.ts` 放在 `src/server/nl/`，只依赖 `Runtime` / `Db` 暴露的**只读**方法；`engine/` 不 import `nl/`。
- 工具函数与 LLM 解耦，放在 `src/server/nl/tools.ts`，每个工具 = zod 参数 schema + 纯函数实现，可单测。
- **不让 LLM 写 SQL**：固定工具从根上不返回 `webhooks.secret` / `headers`，也避免注入与误写。
- 服务端无会话状态：前端每次带上历史消息（有上限），服务端不落库对话。

## 3. 工具清单

数字一律来自工具返回值；工具返回**统计结果**而非原始点列，控制 token。

### 3.1 行情

| 工具 | 参数 | 数据来源 | 说明 |
|------|------|----------|------|
| `list_symbols` | — | `runtime.symbols()` + hub 状态 | 已订阅交易对、各自是否就绪、ticker 是否到达 |
| `market_snapshot` | `symbol`, `metrics: string[]`（CATALOG 名） | `runtime.snapshot()` | 当前值；窗口未就绪返回 null 并标注 `warming`（不变量 4 的延伸：不把 null 说成 0） |
| `metric_stats` | `symbol`, `metric`, `from`, `to` | `runtime.seriesFor()` | first / last / min / max / avg / 极值时刻 / 有效点数 / 缺口比例 |
| `rank_symbols` | `metric`, `order` | 对所有已订阅交易对调 `snapshot` | "哪个币现在买入最猛" |
| `rest_ticker_24h` | `symbol` | Binance REST `/api/v3/ticker/24hr` | **仅用于未订阅的交易对**；复用 `config.binanceRest`，与 `checkSymbol` 同一依赖，5s 超时 |

**超出保留期即拒答**：`from` 早于 `now - METRIC_RETENTION_DAYS`（默认 7 天）时，`metric_stats` 不截断成部分结果，直接返回 `{ error: "insufficient_data", retained_from }`。提示词要求助手据此回答"指标历史只保留最近 N 天，数据不够，无法回答"，不得用剩余数据外推。保留天数在请求时动态写入工具描述。注意这只限制**指标历史**：`events` / `deliveries` 永久保留（不变量 8），"上个月触发了几次"仍可回答。

未订阅交易对的实时窗口指标拿不到。助手应如实说明，并建议"建一个该币的 Signal 或把它加入 `SYMBOLS`"。V1 不做临时订阅：`runtime` 的订阅集由 Signal 和配置决定，临时订阅会引入释放时机和预热等问题，收益不大。

### 3.2 Signal / 事件

| 工具 | 参数 | 数据来源 |
|------|------|----------|
| `list_signals` | — | `db.listSignals()` + `runtime.allStatus()`：id、标题、币对、状态（WARMING/ARMED/...）、启用与否 |
| `get_signal` | `id` | spec + `describeCondition()` 文本 + 当前叶子左右值（`runtime.preview`） |
| `event_stats` | `signal_id?`, `from`, `to`, `group_by?: hour\|signal` | `events` 表聚合：次数、首末时间、分桶计数 |
| `list_events` | `signal_id?`, `from`, `to`, `limit ≤ 20` | 事件摘要：时间、叶子左右值（来自快照，不读当前定义，不变量 6） |
| `delivery_failures` | `from`, `to`, `limit ≤ 20` | `deliveries` 中 `ok=0`：webhook 名、状态码、错误、attempt；**不含 URL query、headers、secret** |

现有 `db.listEvents(signalId, limit)` / `listDeliveries(opts)` 不支持时间范围和聚合，需要在 `db.ts` 新增只读方法：`eventStats(from, to, groupBy, signalId?)`、`listEventsBetween(...)`、`failedDeliveriesBetween(...)`。`events(signal_id, ts)` 已有索引；按时间跨 Signal 查询需要补一个 `events(ts)` 索引，它是 `CREATE INDEX IF NOT EXISTS`，对已有库兼容。

### 3.3 创建 / 修改

| 工具 | 参数 | 行为 |
|------|------|------|
| `draft_signal` | `request: string`, `base_spec?: Spec` | 调 `parseNaturalLanguage()`（扩展支持 `base_spec`：把现有 spec 放进 user 消息，要求"在此基础上修改"）。沿用 `SYSTEM_PROMPT`、`validateSpec` 修复循环与规则兜底。返回 `{spec, explanation, assumptions, warnings}` |

`draft_signal` 只产出提案，不保存。保存仍走现有 `POST /api/signals`，用户在界面上确认并绑定 Webhook 后才保存。

为什么把 DSL 生成做成工具，而不是让对话 LLM 直接吐 spec：DSL 的提示词、示例和校验修复循环都已在 `parse.ts` 里调好，对话 LLM 的提示词专注于"选工具 + 组织回答"，两份提示词互不污染。代价是多一次 LLM 调用，可以接受。

## 4. 对话循环（`chat.ts`）

LLM 接口沿用现有 OpenAI 兼容 `/chat/completions`（`callLlm` 抽到 `src/server/nl/llm.ts` 共用）。

工具调用协议：**优先用原生 `tools` / `tool_calls`**。如果模型不支持（返回里没有 `tool_calls` 且内容是 JSON），回落到提示词约定的 JSON 协议 `{"tool": name, "args": {...}}` / `{"final": {...}}`，解析复用 `extractJson()`。模型不写死，沿用 `LLM_BASE_URL` / `LLM_MODEL`（OpenAI 兼容，实际使用 DeepSeek）；用实际配置的模型实测后，再决定是否保留回落路径。

```
messages = [system(CHAT_PROMPT), ...history(截断), user]
for round in 0..MAX_ROUNDS(6):
    resp = callLlm(messages, tools)
    if resp 是工具调用:
        args = zod 校验（失败 → 把错误作为 tool 结果回灌）
        result = 执行工具（单个工具 5s 超时，结果 JSON 截断到 4KB）
        记录 trace[] ← {tool, args, result}
        messages += [assistant(tool_call), tool(result)]
        continue
    final = 解析最终回答
    return { answer, trace, proposal? }
超出轮数 → 返回已有 trace + "未能在限定步数内完成"
```

`CHAT_PROMPT` 要点：

- 你是 Binance 现货行情与信号助手。所有数字必须来自工具结果，没取到就说没取到。
- 只陈述事实，不预测涨跌，不给买卖建议。
- 指标为 null 表示窗口预热中或无成交，不能说成 0。
- 百分比字段是小数（0.01 = 1%）。时间用用户时区（前端在请求里带上 `tz`）。
- 用户要建/改提醒时调用 `draft_signal`。如果刚查过相关数值，把数值写进 `request` 作为阈值参考，例如"当前 10s 买入额约 12 万 USDT"。
- 回答用用户的语言，简洁，先结论后数据。

## 5. 接口

`POST /api/chat`（经 `auth.ts` 鉴权，不加入例外名单）

```jsonc
// 请求
{
  "messages": [{ "role": "user" | "assistant", "content": "..." }],  // ≤ 20 条，总长 ≤ 16K 字符
  "context": { "spec": { ... } },   // 可选：当前编辑中的 spec，供"改成 2 倍"这类指代
  "tz": "Asia/Shanghai"
}
// 响应
{
  "answer": "...",
  "trace": [{ "tool": "market_snapshot", "args": {...}, "result": {...} }],
  "proposal": { "spec": {...}, "explanation": "...", "assumptions": [], "warnings": [], "parser": "llm" } | null
}
```

- 未配置 LLM（`config.llm === null`）时，行情询问返回 503 并给出明确提示；创建意图仍可用：前端回落到现有 `/api/parse`（规则解析）。
- `/api/parse` 保留不动，向后兼容。
- V1 不做流式。等待期间前端显示"正在查询 market_snapshot…"需要 SSE，放到 V2。

## 6. 前端

**助手页与 Create 页暂时分开**：新增 `web/src/pages/Assistant.tsx`（导航新增「助手」），Create 页保持不动。理由：Create 页是已验证的主路径，未配置 LLM 时靠规则解析照常可用；助手是新功能，提示词和工具都要迭代，分开可以独立演进、出问题不影响建信号。代价是两处都有"一句话建信号"的入口，需要在 P2 之后根据使用情况决定是否合并。

助手页左右两栏：

- **左：对话**。消息列表 + 输入框 + 示例问题，示例包括创建类和询问类各几条。每条助手回答下可展开「数据来源」，用表格列出 trace 中的工具和关键数值；`metric_stats` 附一个 `LineChart` 迷你图，数据按需从 `/api/metrics/series` 拉取。
- **右：提案面板**。最近一次 `proposal` 存在时显示 `SpecView`、Explanation、Assumptions、Preview（只读，复用 `bits.tsx` 组件）。不在助手页里做保存：提供「在创建页打开」按钮，经路由 state 把 spec 带到 Create 页，由 Create 页完成编辑 DSL、绑定 Webhook、保存。这样保存逻辑只有一份。对话中的后续修改把当前提案 spec 作为 `context.spec` 带上。
- 从 SignalDetail 页可以"用助手修改"，带着该 Signal 的 spec 跳转过来。保存时走 `PUT /api/signals/:id`。

历史消息只存在页面 state 里，可选存到 `sessionStorage`；不落库。

## 7. 安全与成本

- 鉴权：`/api/chat` 走现有 onRequest 钩子。
- 敏感字段：工具层白名单输出字段。加一个单测：遍历所有工具的输出，断言不含 `secret`、`headers`、`authorization`。
- 资源上限：每请求最多 6 轮工具调用 + 1 次 `draft_signal` 内部的 ≤ 2 轮；总超时 90s；同一时刻最多 2 个并发 chat 请求（简单信号量），超出返回 429。
- 提示注入：工具结果中唯一的用户可控文本是 Signal 的 title/description/source_text。它们作为 JSON 字段值回灌，而且工具全部只读，最坏情况是回答被带偏，不会产生写操作。

## 8. 测试

`test/` 新增：

1. `tools.test.ts`：用假 `Runtime` / `Db` 测每个工具，包括 null 值透传、range 上限、limit 截断、敏感字段不出现。
2. `chat.test.ts`：注入假 `callLlm`，按剧本返回 tool_call / final，覆盖这几种情况：
   - 参数校验失败后回灌并修正
   - 超出轮数
   - `draft_signal` 返回非法 spec 时走规则兜底
   - 原生 tool_calls 与 JSON 回落两条路径
3. `parse.test.ts` 补 `base_spec` 修改用例，例如把倍数从 3 改成 2 后仍通过 `validateSpec`。

端到端：按 AGENTS.md 流程启动，在配置真实 LLM 的情况下手测下面几类问题：

- "BTC 现在买卖哪边强"
- "过去 1 小时 BTC 1m 收益率最高多少"
- "最近 24 小时触发最多的 Signal"
- "那就超过现在 3 倍时提醒我"（确认提案里的阈值合理，保存后能正常预热、触发）

## 9. AGENTS.md 需补充

在架构不变量里新增第 11 条：

> 11. **助手（`src/server/nl/chat.ts`）只读**。工具只能调用 Runtime / Db 的只读方法，不得写库、不得启停或保存 Signal；建/改 Signal 只产出提案，保存必须由用户在界面确认后走 `/api/signals`。工具输出按字段白名单返回，不得包含 webhook secret / headers。回答中的数字必须来自工具结果。

同时更新代码地图：`nl/llm.ts`、`nl/tools.ts`、`nl/chat.ts`，以及「助手」页。

## 10. 分期

| 阶段 | 内容 | 验收 |
|------|------|------|
| **P1** | `llm.ts` 抽取；`tools.ts`（行情 + Signal/事件工具）；`chat.ts` 循环；`/api/chat`；最简对话 UI（不含提案面板） | 能回答第 8 节的前三类问题，trace 可见 |
| **P2** | `draft_signal` + `base_spec`；提案面板 +「在创建页打开」；Create 页接收路由 state 中的 spec；SignalDetail "用助手修改" | 询问 → 建信号 → 保存 → 触发 全链路 |
| **P3** | SSE 流式进度；`rest_ticker_24h` 补未订阅交易对；可选 K 线工具 | — |

## 11. 已定

1. 模型：不用 MiniMax，使用 DeepSeek（OpenAI 兼容端点）。`config.ts` 默认模型与 `.env.example` 已改为 `deepseek-flash`（已确认用 Flash，不用 Pro；旧名 deepseek-chat / deepseek-reasoner 已停用）。思考模式按用途开关待定。P1 开工第一步实测 DeepSeek 原生 tool calling，决定 JSON 回落路径是否需要。
2. 指标历史超出 `METRIC_RETENTION_DAYS` 的问题直接拒答（数据不够），不外推，不调大默认保留期。
3. 助手页与 Create 页暂时分开，提案经「在创建页打开」交给 Create 页保存。
4. 思考模式按用途分开：生成 DSL（parse.ts）开，对话工具循环（chat.ts）关。
5. 多轮对话：服务端无状态，前端每次带历史（≤20 条 / 16K 字符）；助手消息附带服务端生成的取数摘要 digest 回传；历史存 sessionStorage。

## 12. P1 实现备注

- P1 只实现原生 tools 协议，未做 JSON 回落；若 deepseek-flash 实测工具调用不稳定再补。
- `rest_ticker_24h`（未订阅交易对）留在 P3；P1 对未订阅交易对返回 `not_subscribed`。
- `metric_stats` 不要求交易对当前已订阅（取消订阅前的历史仍可查），无数据返回 `no_data`。
- 本机无外网，P1 只用单测 + 本地假 LLM 验证了 `/api/chat` 链路（鉴权、工具调用、thinking=disabled 下发）。
