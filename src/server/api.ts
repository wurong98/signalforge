import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import type { ServerBuild } from '../shared/build.ts';
import { CATALOG, CATALOG_BY_NAME, catalogDescription } from '../shared/catalog.ts';
import { SYMBOL_RE, WebhookInputSchema, describeFormula, metricUnit, validateSpec } from '../shared/dsl.ts';
import type { BinanceHub } from './binance/stream.ts';
import { config } from './config.ts';
import type { Db } from './db.ts';
import type { Runtime } from './engine/runtime.ts';
import { parseNaturalLanguage } from './nl/parse.ts';
import type { WebhookDispatcher } from './webhook/delivery.ts';

const RANGES: Record<string, number> = { '1m': 60_000, '5m': 300_000, '15m': 900_000, '1h': 3_600_000 };

function bad(reply: FastifyReply, errors: string[] | string, code = 400) {
  return reply.code(code).send({ errors: Array.isArray(errors) ? errors : [errors] });
}

/** 通过 Binance REST 确认交易对存在（PRD §25 Subscription failure 的前置防线） */
async function checkSymbol(symbol: string): Promise<string | null> {
  try {
    const res = await fetch(`${config.binanceRest}/api/v3/exchangeInfo?symbol=${symbol}`, { signal: AbortSignal.timeout(5_000) });
    if (res.status === 400) return `Binance 不存在交易对 ${symbol}`;
    return null;
  } catch {
    return null; // REST 不可达时不阻塞创建；WS 订阅失败会在 Data Sources 中可见
  }
}

export function registerApi(app: FastifyInstance, deps: { db: Db; runtime: Runtime; hub: BinanceHub; dispatcher: WebhookDispatcher; build: ServerBuild }) {
  const { db, runtime, hub, dispatcher } = deps;
  const idParam = (req: any) => Number(req.params.id);

  // ---------- 系统状态 / 实时推送 ----------
  const statusPayload = () => {
    const h = hub.getStatus();
    return {
      server_time: Date.now(),
      binance: h,
      symbols: runtime.symbols(),
      llm: config.llm ? { enabled: true, model: config.llm.model } : { enabled: false },
    };
  };
  app.get('/api/status', async () => statusPayload());
  // 需登录：不向未鉴权访问者暴露具体版本
  app.get('/api/version', async () => deps.build);

  app.get('/api/live', (req, reply) => {
    reply.raw.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    const send = (event: string, data: unknown) => reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    const push = () => send('tick', { ...statusPayload(), signals: runtime.allStatus() });
    push();
    const timer = setInterval(push, 1_000);
    const onEvent = (e: any) => send('signal_event', { id: e.id, signal_id: e.signal_id, ts: e.ts, title: e.spec.title });
    runtime.on('event', onEvent);
    req.raw.on('close', () => {
      clearInterval(timer);
      runtime.off('event', onEvent);
    });
  });

  // ---------- 自然语言 ----------
  app.post('/api/parse', async (req, reply) => {
    const body = z.object({ text: z.string().min(2).max(1000) }).safeParse(req.body);
    if (!body.success) return bad(reply, '请输入要监控的内容');
    const out = await parseNaturalLanguage(body.data.text, config.llm);
    if ('error' in out) return bad(reply, [out.error, ...out.warnings], 422);
    return out;
  });

  app.post('/api/preview', async (req, reply) => {
    const v = validateSpec((req.body as any)?.spec);
    if (!v.ok) return bad(reply, v.errors);
    return {
      ...runtime.preview(v.spec),
      metrics: v.spec.metrics.map((m) => ({ name: m.name, formula: describeFormula(m), unit: metricUnit(m, v.spec.metrics) })),
    };
  });

  // ---------- Signals ----------
  const SignalBody = z.object({
    spec: z.unknown(),
    webhook_id: z.number().int().nullable().optional(),
    webhook: WebhookInputSchema.optional(),
    source_text: z.string().max(1000).optional(),
  });

  async function resolveBody(body: unknown, reply: FastifyReply, exceptId?: number) {
    const b = SignalBody.safeParse(body);
    if (!b.success) return bad(reply, b.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`)), null;
    const v = validateSpec(b.data.spec);
    if (!v.ok) return bad(reply, v.errors), null;
    if (!SYMBOL_RE.test(v.spec.market.symbol)) return bad(reply, 'invalid symbol'), null;
    if (db.signalNameTaken(v.spec.name, exceptId)) return bad(reply, `Signal 名称 ${v.spec.name} 已存在`), null;
    const symErr = await checkSymbol(v.spec.market.symbol);
    if (symErr) return bad(reply, symErr), null;
    let webhookId = b.data.webhook_id ?? null;
    if (b.data.webhook) webhookId = db.insertWebhook(b.data.webhook);
    if (webhookId !== null && !db.getWebhook(webhookId)) return bad(reply, 'webhook 不存在'), null;
    return { spec: v.spec, webhookId, sourceText: b.data.source_text ?? '' };
  }

  app.get('/api/signals', async () => {
    const status = new Map(runtime.allStatus().map((s) => [s.id, s]));
    return db.listSignals().map((s) => ({ ...s, runtime: status.get(s.id) }));
  });

  app.post('/api/signals', async (req, reply) => {
    const r = await resolveBody(req.body, reply);
    if (!r) return;
    const id = db.insertSignal(r.spec, r.webhookId, r.sourceText);
    runtime.sync();
    return { id };
  });

  app.get('/api/signals/:id', async (req, reply) => {
    const s = db.getSignal(idParam(req));
    if (!s) return bad(reply, 'not found', 404);
    return {
      ...s,
      webhook: s.webhook_id ? db.getWebhook(s.webhook_id) : null,
      runtime: runtime.status(s.id),
      metrics: s.spec.metrics.map((m) => ({ ...m, formula: describeFormula(m), unit: metricUnit(m, s.spec.metrics) })),
    };
  });

  app.put('/api/signals/:id', async (req, reply) => {
    const id = idParam(req);
    if (!db.getSignal(id)) return bad(reply, 'not found', 404);
    const r = await resolveBody(req.body, reply, id);
    if (!r) return;
    db.updateSignal(id, r.spec, r.webhookId);
    runtime.sync();
    return { id };
  });

  for (const action of ['enable', 'disable'] as const) {
    app.post(`/api/signals/:id/${action}`, async (req, reply) => {
      const id = idParam(req);
      if (!db.getSignal(id)) return bad(reply, 'not found', 404);
      db.setSignalEnabled(id, action === 'enable');
      runtime.sync();
      return { ok: true };
    });
  }

  app.post('/api/signals/:id/duplicate', async (req, reply) => {
    const s = db.getSignal(idParam(req));
    if (!s) return bad(reply, 'not found', 404);
    let n = 2;
    while (db.signalNameTaken(`${s.spec.name}-${n}`)) n++;
    const spec = { ...s.spec, name: `${s.spec.name}-${n}`.slice(0, 64), title: `${s.spec.title} (copy)`.slice(0, 80) };
    const id = db.insertSignal(spec, s.webhook_id, s.source_text);
    db.setSignalEnabled(id, false);
    runtime.sync();
    return { id };
  });

  app.delete('/api/signals/:id', async (req) => {
    db.deleteSignal(idParam(req));
    runtime.sync();
    return { ok: true };
  });

  app.get('/api/signals/:id/series', async (req, reply) => {
    const s = db.getSignal(idParam(req));
    if (!s) return bad(reply, 'not found', 404);
    const range = RANGES[(req.query as any).range] ?? RANGES['15m'];
    return { points: runtime.seriesFor(s.spec.market.symbol, `signal:${s.id}`, range) };
  });

  // ---------- Events ----------
  app.get('/api/events', async (req) => {
    const q = req.query as any;
    return db.listEvents(q.signal_id ? Number(q.signal_id) : null, Math.min(Number(q.limit ?? 50), 200));
  });

  app.get('/api/events/:id', async (req, reply) => {
    const e = db.getEvent(idParam(req));
    if (!e) return bad(reply, 'not found', 404);
    return {
      ...e,
      deliveries: db.listDeliveries({ eventId: e.id }),
      metrics: e.spec.metrics.map((m) => ({ name: m.name, formula: describeFormula(m), unit: metricUnit(m, e.spec.metrics) })),
    };
  });

  // ---------- Webhooks ----------
  app.get('/api/webhooks', async () =>
    db.listWebhooks().map((w) => ({
      ...w,
      secret: w.secret ? '••••••' : '',
      stats: db.webhookStats(w.id),
      signals: db.listSignals().filter((s) => s.webhook_id === w.id).map((s) => ({ id: s.id, title: s.spec.title })),
    })),
  );

  app.post('/api/webhooks', async (req, reply) => {
    const b = WebhookInputSchema.safeParse(req.body);
    if (!b.success) return bad(reply, b.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`));
    return { id: db.insertWebhook(b.data) };
  });

  app.put('/api/webhooks/:id', async (req, reply) => {
    const id = idParam(req);
    const cur = db.getWebhook(id);
    if (!cur) return bad(reply, 'not found', 404);
    const input = { ...(req.body as any) };
    // 前端拿到的是掩码，未修改时保留原 secret
    if (input.secret === '••••••') input.secret = cur.secret;
    const b = WebhookInputSchema.safeParse(input);
    if (!b.success) return bad(reply, b.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`));
    db.updateWebhook(id, b.data);
    runtime.sync();
    return { ok: true };
  });

  app.delete('/api/webhooks/:id', async (req) => {
    db.deleteWebhook(idParam(req));
    runtime.sync();
    return { ok: true };
  });

  app.post('/api/webhooks/:id/test', async (req, reply) => {
    const w = db.getWebhook(idParam(req));
    if (!w) return bad(reply, 'not found', 404);
    // 飞书测试卡片用真实行情快照；通用 Webhook 的测试报文不变
    const live = runtime.latestTicker();
    const payload = {
      event: 'signal.test',
      signal: 'test',
      exchange: 'binance',
      market: 'spot',
      symbol: live?.symbol ?? 'BTCUSDT',
      timestamp: Date.now(),
      metrics: { buy_notional_10s: 9213481.21, sell_notional_10s: 2821731.82, ratio: 3.26 },
    };
    // 测试只尝试一次，立即返回结果
    return dispatcher.deliver({ ...w, max_retries: 0 }, payload, null, true, { ticker: live?.ticker });
  });

  app.get('/api/webhooks/:id/deliveries', async (req) => db.listDeliveries({ webhookId: idParam(req), limit: 100 }));

  // ---------- Explore ----------
  app.get('/api/catalog', async () =>
    CATALOG.map((m) => ({ ...m, formula: describeFormula(m), unit: metricUnit(m, CATALOG), description: catalogDescription(m.name) })),
  );

  app.get('/api/metrics/series', async (req, reply) => {
    const q = req.query as any;
    const symbol = String(q.symbol ?? 'BTCUSDT').toUpperCase();
    const names = String(q.metrics ?? '').split(',').filter((n) => CATALOG_BY_NAME.has(n));
    if (!names.length) return bad(reply, 'metrics required');
    const range = RANGES[q.range] ?? RANGES['5m'];
    return {
      symbol,
      current: runtime.snapshot(symbol, names),
      series: Object.fromEntries(names.map((n) => [n, runtime.seriesFor(symbol, n, range)])),
    };
  });

  // ---------- Data Sources ----------
  app.get('/api/datasources', async () => {
    const h = hub.getStatus();
    // 每个交易对有 aggTrade / ticker 两条流，样例按 `SYMBOL@stream` 区分
    return {
      ...h,
      samples: Object.fromEntries(h.streams.map((s) => [`${s.symbol}@${s.stream}`, hub.samples(s.symbol, s.stream).slice(0, 5)])),
    };
  });
}
