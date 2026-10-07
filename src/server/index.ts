import { existsSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { resolve } from 'node:path';
import fastifyStatic from '@fastify/static';
import Fastify from 'fastify';
import { formatBuild } from '../shared/build.ts';
import { registerApi } from './api.ts';
import { Auth, registerAuth } from './auth.ts';
import { MarketHub } from './binance/stream.ts';
import { config } from './config.ts';
import { Db } from './db.ts';
import { Runtime } from './engine/runtime.ts';
import { readBuildInfo } from './version.ts';
import { WebhookDispatcher } from './webhook/delivery.ts';

const db = new Db(config.dbPath);
const hub = new MarketHub(config.binanceWs, config.binanceFuturesWs);
const dispatcher = new WebhookDispatcher(db, config.allowPrivateWebhooks);
const runtime = new Runtime(db, hub, dispatcher, config.symbols, config.metricRetentionDays);

const build = { ...readBuildInfo(), started_at: Date.now() };

// forceCloseConnections：关闭时断开所有连接。/api/live 是永不结束的 SSE 长连接，
// 默认只断空闲连接，app.close() 会一直等它而卡住，Ctrl+C 停不下来
const app = Fastify({ logger: { level: 'warn' }, forceCloseConnections: true });
const auth = new Auth(config.adminFile);
// 必须先于业务路由注册：onRequest 钩子拦截所有未鉴权的 /api 请求
registerAuth(app, auth);
registerApi(app, { db, runtime, hub, dispatcher, build });

const webDir = resolve('dist/web');
if (existsSync(webDir)) {
  await app.register(fastifyStatic, { root: webDir });
  // SPA 路由回落
  app.setNotFoundHandler((req, reply) =>
    req.url.startsWith('/api/') ? reply.code(404).send({ errors: ['not found'] }) : reply.sendFile('index.html'),
  );
}

runtime.start();
await app.listen({ port: config.port, host: config.host });
console.log(`SignalForge ${formatBuild(build)} listening on http://${config.host}:${config.port}`);
if (config.host === '0.0.0.0' || config.host === '::') {
  for (const addrs of Object.values(networkInterfaces()))
    for (const a of addrs ?? []) if (a.family === 'IPv4' && !a.internal) console.log(`  LAN: http://${a.address}:${config.port}`);
} else if (config.host === '127.0.0.1' || config.host === 'localhost') {
  console.log('  (仅本机可访问；临时共享给局域网请用 npm run share)');
}
console.log(
  auth.configured()
    ? `  Admin password: set (${config.adminFile}；忘记密码删除该文件即可重设)`
    : '  WARNING: 尚未设置管理密码——第一个打开页面的人将设置它，请尽快完成设置',
);
console.log(`  Binance: spot ${config.binanceWs} · futures ${config.binanceFuturesWs}  symbols: ${config.symbols.join(',')}`);
console.log(`  NL parser: ${config.llm ? `LLM (${config.llm.model} @ ${config.llm.baseUrl})` : 'rules only (set LLM_BASE_URL / LLM_API_KEY)'}`);
if (config.allowPrivateWebhooks) console.log('  WARNING: ALLOW_PRIVATE_WEBHOOKS=true — webhooks may target private networks');

/**
 * 停止顺序保证数据完整：
 * 1. runtime.stop()：停止求值并把未落盘的指标点同步写入（同步执行，之后的强制退出也不会丢）；
 * 2. app.close()：断开所有连接（含 SSE）；
 * 3. db.close()：WAL 合并回主库后关闭。
 * node:sqlite 的写入是同步事务，process.exit 只会发生在两次写入之间，不会打断事务；
 * 强制退出路径同样先关库。
 */
let stopping = false;
const closeDb = () => {
  try {
    db.close();
  } catch (e) {
    console.error('[db] close failed', e);
  }
};
const forceExit = (why: string) => {
  console.error(why);
  closeDb();
  process.exit(1);
};
for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, async () => {
    // 第二次 Ctrl+C：不再等连接关闭，关库后立即退出
    if (stopping) return forceExit('强制退出');
    stopping = true;
    console.log(`\n${sig}: 正在停止…（再按一次 Ctrl+C 强制退出）`);
    // 兜底：关闭流程因任何原因卡住时 5 秒后强制退出
    setTimeout(() => forceExit('停止超时，强制退出'), 5_000).unref();
    runtime.stop();
    await app.close();
    closeDb();
    process.exit(0);
  });
}
