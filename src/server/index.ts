import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import fastifyStatic from '@fastify/static';
import Fastify from 'fastify';
import { registerApi } from './api.ts';
import { BinanceHub } from './binance/stream.ts';
import { config } from './config.ts';
import { Db } from './db.ts';
import { Runtime } from './engine/runtime.ts';
import { WebhookDispatcher } from './webhook/delivery.ts';

const db = new Db(config.dbPath);
const hub = new BinanceHub(config.binanceWs);
const dispatcher = new WebhookDispatcher(db, config.allowPrivateWebhooks);
const runtime = new Runtime(db, hub, dispatcher, config.symbols, config.metricRetentionDays);

const app = Fastify({ logger: { level: 'warn' } });
registerApi(app, { db, runtime, hub, dispatcher });

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
console.log(`SignalForge listening on http://${config.host}:${config.port}`);
console.log(`  Binance: ${config.binanceWs}  symbols: ${config.symbols.join(',')}`);
console.log(`  NL parser: ${config.llm ? `LLM (${config.llm.model} @ ${config.llm.baseUrl})` : 'rules only (set LLM_BASE_URL / LLM_API_KEY)'}`);
if (config.allowPrivateWebhooks) console.log('  WARNING: ALLOW_PRIVATE_WEBHOOKS=true — webhooks may target private networks');

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, async () => {
    runtime.stop();
    await app.close();
    process.exit(0);
  });
}
