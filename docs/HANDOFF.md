# 交接文档 — SignalForge V1

- 日期：2026-09-29
- 分支：`feat/v1-core`（基于 `master` 的 Initial commit）
- 状态：V1 的 P0 + P1 已实现，在真实 Binance 数据上端到端验证通过；未部署、无远程仓库

## 1. 已完成

| PRD 优先级 | 项目 | 状态 | 位置 |
|-----------|------|------|------|
| P0 | Binance WS / aggTrade / BTCUSDT | ✅ 含重连、假死检测、动态订阅 | `src/server/binance/stream.ts` |
| P0 | Metric Window Engine（1/3/5/10/30/60s） | ✅ sum count avg min max first last delta return | `src/server/engine/window.ts` |
| P0 | Signal Engine + 状态机 + cooldown | ✅ | `src/server/engine/signal.ts` |
| P0 | Webhook（签名、重试、日志、Test） | ✅ | `src/server/webhook/delivery.ts` |
| P0 | Signal Event Log | ✅ 永久保存，含定义快照 | `src/server/db.ts` |
| P1 | 自然语言 → DSL | ✅ LLM（OpenAI 兼容）+ 规则兜底 | `src/server/nl/` |
| P1 | Signal Create UI | ✅ 解析、Preview、编辑 DSL、绑定 Webhook | `web/src/pages/Create.tsx` |
| P1 | Metric Chart | ✅ | `web/src/components/LineChart.tsx` |
| P1 | Signal Explain | ✅ 基于快照 | `web/src/components/bits.tsx` |
| — | Explore / Webhooks / Data Sources 页面 | ✅ | `web/src/pages/` |

验证记录：
- `npm test`：14/14 通过；`npm run typecheck` 通过。
- 真实数据：核心 Demo 句子经 MiniMax-M2 解析 → 创建 → 约 4 分钟触发 9 次，Webhook 全部 200，延迟 3–6ms。
- 6 个页面均用 headless Chrome 截图检查过渲染。

## 2. 关键设计决定（PRD 未规定，由实现确定）

详细论证见 `docs/prd-review.md`，这里只列结论，后续改动请保持一致或显式推翻：

1. 状态机：`WARMING → ARMED ⇄ COOLDOWN → ACTIVE → ARMED`，只在"假→真"边沿触发，启动时已为真不触发。
2. 窗口就绪：连续接收时长 ≥ 窗口长度才求值；断线即回到 WARMING。
3. 窗口时间：交易所成交时间 T，滑动，200ms tick 推进。
4. 噪声下限：相对比较默认追加绝对成交额下限（BTC 10s ≥ 50K USDT，ETH 20K，其他 5K，随窗口线性缩放），作为 Assumption 展示。
5. Webhook：`X-SignalForge-Signature: sha256=HMAC(secret, "{ts}.{body}")`；5xx/408/429/网络错误重试 1s/5s/30s；至少一次语义，接收方按 `event_id` 去重。
6. SSRF：默认拒绝私有地址，不跟随重定向。

## 3. 配置

见 `.env.example`。要点：

| 变量 | 说明 |
|------|------|
| `LLM_BASE_URL` / `LLM_API_KEY` / `LLM_MODEL` | 不配置则只用规则解析（仅支持"买卖 N 倍"与"涨跌 N%"句式）。也会回退读取 `OPENAI_BASE_URL` / `OPENAI_API_KEY` |
| `BINANCE_WS_URL` | 被墙环境可改为 `wss://data-stream.binance.vision` |
| `ALLOW_PRIVATE_WEBHOOKS` | 本地测试需设为 `true` |
| `HOST` | 默认 `127.0.0.1`。公网部署前务必先完成管理密码设置，并在前面放 HTTPS 反代 |
| `ADMIN_FILE` | 管理密码哈希文件，默认 `./data/admin.json`。首次打开页面时设置；忘记密码删除此文件即可重设 |

## 4. 已知问题与限制

| 类别 | 问题 | 建议 |
|------|------|------|
| 安全 | 单一管理密码，无多用户；首次设置前任何人都能抢先设置 | 公网部署后立即打开页面完成设置；需要多用户时再扩展 |
| 可靠性 | 进程重启时正在重试的 Webhook 会丢失（重试队列在内存中） | 事件的 `delivery_status` 会停留在 `pending`；可在启动时扫描并重投 |
| 可靠性 | 单连接承载所有交易对；新增交易对通过 SUBSCRIBE，但 Binance 单连接上限 1024 streams | 多交易对规模化时分片连接 |
| 准确性 | 滑动窗口 sum 用加减维护，长期运行有浮点累计误差（count 归零时会重置） | 若需严格精度，定期从缓冲区重算 |
| 数据 | `metric_points` 约 31 指标 × 1 点/秒，7 天约 1900 万行/交易对 | 多交易对前做降采样（如 >1h 存 5s 粒度） |
| 产品 | 相对条件在行情活跃时触发很频繁（实测 BTC 3x/10s 约 30–60 秒一次） | 做 §4 的"触发频率预估" |
| 前端 | 编辑 Signal 目前是直接编辑 DSL JSON | 做结构化表单编辑 |
| 前端 | 无前端测试 | 需要时加 Playwright |

## 5. 下一步建议（按价值排序）

1. **触发频率预估**：Create 页 Preview 显示"过去 1 小时会触发几次"。可基于 `metric_points` 或内存中的原始成交回放实现，复用 `SignalStateMachine`。
2. **启动时重投 pending 的 Webhook**（见第 4 节）。
3. **P2 数据源**：bookTicker（spread / spread_bps）→ depth（订单簿重建 + depth_imbalance）。DSL 的 `stream` 目前是字面量 `'aggTrade'`，需扩展为联合类型，窗口引擎需要支持非成交类事件。
4. Signal 事件记录"退出满足"的时间（持续时长）。

## 6. 如何接手

```bash
npm install
npm test && npm run typecheck
cp .env.example .env   # 填 LLM key，本地测试设 ALLOW_PRIVATE_WEBHOOKS=true
npm run dev            # 打开 http://localhost:5173
```

先读 `AGENTS.md`（架构不变量），再读 `docs/prd-review.md`（为什么这样设计）。
