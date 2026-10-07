# AGENTS.md

给在本仓库工作的 AI Agent（Claude Code / Codex 等）的说明。人类读者请先看 `README.md`。

## 项目一句话

Binance Signal Studio：自然语言 → Signal DSL → 确定性 Runtime（Binance aggTrade → 滑动窗口指标 → 条件 → 状态机 → Event → Webhook）。

## 常用命令

| 目的 | 命令 |
|------|------|
| 安装 | `npm install` |
| 开发（后端 8787 + Vite 5173） | `npm run dev` |
| 生产构建 + 启动 | `npm run build && npm start` |
| 测试 | `npm test`（node:test + tsx，约 1 秒） |
| 类型检查 | `npm run typecheck` |

提交前必须 `npm test` 与 `npm run typecheck` 全绿。

运行环境：Node ≥ 22.13。使用内置 `node:sqlite` 和全局 `WebSocket`，**不要引入原生依赖**（如 better-sqlite3、ws）。

## 架构不变量（改代码前必读）

1. **LLM 不参与实时路径**。`src/server/nl/` 只产出 DSL；`src/server/engine/` 不得 import 任何 LLM 相关代码。
2. **DSL 是唯一契约**。`src/shared/dsl.ts` 同时被前端、后端、LLM 提示词使用。修改 DSL 时同步更新：
   - `validateSpec()` 语义校验
   - `describeFormula()` / `describeCondition()`（Explain 与透明性依赖它们）
   - `src/server/nl/parse.ts` 中的 `SYSTEM_PROMPT` 与示例
   - `src/server/nl/rules.ts` 规则解析器
   - 已存库的 spec 是 JSON，改动须向后兼容或提供迁移
3. **窗口基于交易所成交时间 T**，不是本地时间。`SymbolWindows.advance()` 必须单调。
4. **窗口未就绪返回 null，不返回 0**。启动/重连后连续接收时长 < 窗口长度时，Signal 处于 `WARMING`，不得触发。
5. **只在边沿触发**。状态机见 `src/server/engine/signal.ts` 顶部注释；启动时已满足的条件不触发。改状态机必须同步改 `test/engine.test.ts` 中的状态机用例。
6. **事件自包含**。`events` 表保存触发时的 `spec` 快照与每个叶子条件的左右值；Explain 只读快照，不读当前 Signal 定义。
7. **Webhook 安全**：默认拒绝私有地址、不跟随重定向。不要为了方便测试去掉这些检查——用 `ALLOW_PRIVATE_WEBHOOKS=true`。
8. 事件与投递日志**永久保留**，删除 Signal 不删它们。
9. **长周期需求走 `kind:"ticker"`，不得退化成窗口近似**。aggTrade 窗口上限 5m（`WINDOWS` 末项；窗口时长一律经 `windowMs()` 换算，窗口名可带 s/m/h 后缀，禁止自行 `slice` 按秒解析），"24 小时新低"这类语义只能由 `<symbol>@ticker`（交易所侧维护的 24h 滚动统计，每秒下发、无预热）表达。两个配套约束：
   - ticker **不参与**成交窗口的时钟与预热（`nowEx` / `continuousSince` 仍只由 aggTrade 驱动），只更新快照；
   - 用到 ticker 的 Signal 必须等到**第一条 ticker 到达**才算就绪（`requiresTicker()`）。否则就绪瞬间 ticker 还是 null（条件假 → ARMED），下一秒 ticker 到达、条件转真，会被误判成边沿而触发，直接破坏不变量 5；
   - 断线时 ticker 快照随窗口一起作废（`markDisconnected()` 清空），重连后同样要等第一条新 ticker。旧快照不含断线期间的行情，拿它判就绪会把"断线期间已满足"的条件当成边沿触发，旧极值还会导致误报新低/新高；
   - 创新低/新高用**严格**不等号（`last_1s < low_24h`）。成交价"等于"极值只是恰好停在那儿；用 `<=` 会让条件在整段下跌中持续为真，整个过程只在第一次反弹时触发一次，限频就完全失效了。代价是：若某次 ticker 比 aggTrade 先到、已经包含了这笔新极值，这次会漏报（只会漏、不会误报，下一次创新低照常触发）。
10. **所有 `/api/*` 必须经过管理密码鉴权**（`src/server/auth.ts` 的 onRequest 钩子，须先于业务路由注册），仅 `/api/auth/{status,login,setup}` 例外。新增接口不得绕过；未设置密码时同样拦截。密码哈希在 `ADMIN_FILE`（默认 `data/admin.json`），删除即重置。

## 代码地图

```
src/shared/dsl.ts            DSL schema(zod) + 校验 + 人类可读描述
src/shared/catalog.ts        内置指标（Explore / 提示词），含 24h ticker 指标
src/shared/build.ts          部署版本信息 + 前端构建/服务进程一致性检查（页面底部）
src/server/index.ts          入口：组装 Db / BinanceHub / Dispatcher / Runtime / Fastify
src/server/config.ts         环境变量
src/server/version.ts        读取 git commit / dirty（服务启动与 vite 构建时各读一次）
src/server/api.ts            REST + SSE（/api/live 每秒推送状态）
src/server/auth.ts           管理密码（首次设置 / 文件存储）+ 会话 Cookie + 登录限流
src/server/db.ts             node:sqlite，表：webhooks signals events deliveries metric_points
src/server/binance/stream.ts WS 连接（每对同时订阅 aggTrade + ticker）、重连、假死检测、环形缓存
src/server/engine/window.ts  增量滑动窗口累加器 + 24h ticker 快照
src/server/engine/signal.ts  条件求值 + 状态机
src/server/engine/runtime.ts 编排、采样、事件、派发
src/server/webhook/delivery.ts  签名 / 重试 / SSRF
src/server/nl/parse.ts       LLM 解析 + 校验修复循环
src/server/nl/rules.ts       规则解析兜底 + 噪声下限 + 24h 档
web/src/                     React 前端（lib.ts 为 API/类型/格式化）
test/                        单元测试
docs/                        PRD 评审、交接文档
```

## 风格约定

- TypeScript ESM，import 带 `.ts` 后缀（tsx 与 Vite 都支持）。
- 注释使用中文，解释"为什么"；模块顶部注释引用 PRD 章节号（如 `PRD §23`）。
- 前端不引入 UI 框架和图表库；图表是 `web/src/components/LineChart.tsx` 手写 SVG。
- 样式集中在 `web/src/styles.css`，颜色用 `:root` 变量。

## 验证改动

- 引擎/解析/Webhook 逻辑：加单元测试到 `test/`。
- 端到端：`ALLOW_PRIVATE_WEBHOOKS=true PORT=8799 DB_PATH=/tmp/x.db ADMIN_FILE=/tmp/admin.json npx tsx src/server/index.ts`，
  先 `curl -XPOST localhost:8799/api/auth/setup -H 'content-type: application/json' -d '{"password":"testpass123"}'` 设置密码，
  之后请求都带 `-H 'authorization: Bearer testpass123'`；用 `curl -XPOST localhost:8799/api/signals` 建一个低阈值 Signal（如 1s 窗口、`multiplier: 1.5`、cooldown 3s）
  指向本地 HTTP 接收端，30 秒内应收到签名的 Webhook。
- 注意：`pkill -f "tsx src/server"` 可能误杀自己的 shell，按端口查 pid 再 kill。
