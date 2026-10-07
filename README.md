# SignalForge — Binance Signal Studio

> 用自然语言，把 Binance 实时数据变成可执行 Signal。

```
自然语言 ──LLM──▶ Signal DSL ──校验──▶ Runtime（确定性）
                                       │
Binance aggTrade ─▶ 滑动窗口指标 ─▶ 条件求值 ─▶ 状态机 ─▶ Event ─▶ Webhook
```

## 快速开始

```bash
npm install
cp .env.example .env      # 填写 LLM_API_KEY（可选，不填则使用规则解析器）
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
| `src/shared/catalog.ts` | 内置指标目录（Explore / LLM 提示词） |
| `src/server/binance/stream.ts` | Binance WS：订阅、指数退避重连、假死检测、原始事件环形缓存 |
| `src/server/engine/window.ts` | Window Engine：按成交时间 T 的增量滑动窗口，含预热/就绪判断 |
| `src/server/engine/signal.ts` | 条件求值 + 状态机（WARMING / ARMED / COOLDOWN / ACTIVE） |
| `src/server/engine/runtime.ts` | 编排：事件驱动求值 + 200ms tick、1s 采样、事件落库、Webhook 派发 |
| `src/server/webhook/delivery.ts` | Webhook：HMAC 签名、重试分类、SSRF 防护 |
| `src/server/nl/` | 自然语言解析：OpenAI 兼容 LLM + 校验修复循环；规则解析兜底 |
| `web/src/` | React 前端：Create / Signals / Signal Detail / Explore / Webhooks / Data Sources |
| `docs/prd-review.md` | PRD 评审与实现中做出的规范性决定 |

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

## 测试

```bash
npm test        # 窗口引擎、状态机、DSL 校验、规则解析、Webhook 重试/签名/SSRF
npm run typecheck
```
