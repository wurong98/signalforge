# SignalForge — Binance Signal Studio

> 用自然语言，把 Binance 实时数据变成可执行 Signal。

```
自然语言 ──LLM──▶ Signal DSL ──校验──▶ Runtime（确定性）
                                       │
Binance aggTrade ─▶ 滑动窗口指标（≤5m）─┐
Binance ticker   ─▶ 24h 滚动统计 ───────┴▶ 条件求值 ─▶ 状态机 ─▶ Event ─▶ Webhook / 飞书

提问 ──LLM──▶ 只读工具（实时指标 / 指标历史 / 事件 / 投递 / 币安交易对）──▶ 回答
```

LLM 只用在两处，都不在实时路径上，触发与否完全由确定性引擎决定：

- **Create**：一句话 → Signal DSL，必须通过 `validateSpec` 校验；失败回灌修复一次，仍失败则回落到规则解析器。
- **Assistant**：用自然语言问行情、Signal、触发记录和 Webhook 投递。只读，回答中的数字全部来自工具结果，可展开「数据来源」核对。指标历史只保留 `METRIC_RETENTION_DAYS`（默认 7 天），更早的区间直接拒答。

## 快速开始

```bash
npm install
cp .env.example .env      # 填写 LLM_API_KEY（默认 DeepSeek deepseek-flash；不填则 Create 用规则解析、Assistant 不可用）
npm run build && npm start   # http://127.0.0.1:8787
# 或开发模式（后端 8787 + Vite 5173 热更新）
npm run dev
```

首次打开页面时需要设置**管理密码**，之后所有访问都要先输入它。密码哈希保存在 `data/admin.json`（`ADMIN_FILE`），忘记密码时删除该文件、刷新页面即可重新设置。脚本调用 API 时带 `Authorization: Bearer <管理密码>`。

本地测试 Webhook 时，接收端通常在 localhost，需要设置 `ALLOW_PRIVATE_WEBHOOKS=true`（默认禁止，防 SSRF）。

需要 Node ≥ 22.13（使用内置 `node:sqlite` 与 `WebSocket`，无原生依赖）。

## 目录

| 路径 | 职责 |
|------|------|
| `src/shared/dsl.ts` | Signal DSL（zod schema + 语义校验 + 公式描述），前后端共用 |
| `src/shared/catalog.ts` | 内置指标目录（窗口指标 + 24h ticker 指标；Explore / LLM 提示词） |
| `src/server/auth.ts` | 管理密码、会话 Cookie、登录限流；所有 `/api/*` 鉴权 |
| `src/server/db.ts` | `node:sqlite`：webhooks / signals / events / deliveries / metric_points |
| `src/server/binance/stream.ts` | Binance WS：每个交易对订阅 aggTrade + ticker，指数退避重连、假死检测、原始事件环形缓存 |
| `src/server/binance/symbols.ts` | 币安现货交易对目录（REST exchangeInfo，缓存 1 小时），供助手回答"支持哪些交易对" |
| `src/server/engine/window.ts` | Window Engine：按成交时间 T 的增量滑动窗口，含预热/就绪判断 |
| `src/server/engine/signal.ts` | 条件求值 + 状态机（WARMING / ARMED / COOLDOWN / ACTIVE） |
| `src/server/engine/runtime.ts` | 编排：事件驱动求值 + 200ms tick、1s 采样、事件落库、Webhook 派发 |
| `src/server/webhook/delivery.ts` | Webhook：HMAC 签名、重试分类、SSRF 防护 |
| `src/server/webhook/feishu.ts` | 飞书机器人适配：消息卡片、飞书签名、按响应体判定成败 |
| `src/server/nl/llm.ts` | OpenAI 兼容调用（DeepSeek thinking 开关、tools） |
| `src/server/nl/parse.ts` `rules.ts` | 自然语言 → DSL：LLM + 校验修复循环；规则解析兜底 |
| `src/server/nl/chat.ts` `tools.ts` | 助手：对话循环（`/api/chat`）+ 只读查询工具 |
| `web/src/` | React 前端：Create / Assistant / Signals / Signal Detail / Explore / Webhooks / Data Sources |
| `docs/prd-review.md` | PRD 评审与实现中做出的规范性决定 |
| `docs/llm-assistant-plan.md` | LLM 助手方案与分期 |

## Webhook

```json
{
  "event": "signal.triggered",
  "event_id": 42,
  "signal": "btc-buy-pressure-10s",
  "signal_id": 1,
  "title": "BTC Buy Pressure 10s",
  "exchange": "binance",
  "market": "spot",
  "symbol": "BTCUSDT",
  "timestamp": 1780102200123,
  "condition": "buy_notional_10s > sell_notional_10s × 3 AND buy_notional_10s >= 50000",
  "metrics": { "buy_notional_10s": 9213481.21, "sell_notional_10s": 2821731.82, "ratio": 3.26 }
}
```

- 配置 Secret 后：`X-SignalForge-Signature: sha256=HMAC_SHA256(secret, "{X-SignalForge-Timestamp}.{body}")`
- 网络错误 / 超时 / 5xx / 408 / 429 按 1s → 5s → 30s 重试；其他 4xx 不重试；不跟随重定向
- 至少一次投递语义，接收方请用 `event_id` 去重
- URL 是飞书自定义机器人地址时，自动改发飞书消息卡片；Secret 即飞书"签名校验"密钥；飞书出错也回 HTTP 200，因此按响应体 `code` 判定成败

## 测试

```bash
npm test        # 窗口引擎、状态机、DSL 校验、规则解析、Webhook 重试/签名/SSRF/飞书、鉴权、助手工具与对话循环
npm run typecheck
```
