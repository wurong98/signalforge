import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SymbolDirectory } from '../src/server/binance/symbols.ts';
import { Db } from '../src/server/db.ts';
import type { ChatTurn } from '../src/server/nl/chat.ts';
import { MAX_ROUNDS, runChat, trimHistory } from '../src/server/nl/chat.ts';
import type { LlmCall, LlmMessage, LlmOptions } from '../src/server/nl/llm.ts';
import { buildRequestBody } from '../src/server/nl/llm.ts';
import { parseWithRules } from '../src/server/nl/rules.ts';
import type { ToolDeps } from '../src/server/nl/tools.ts';
import { TOOLS, llmTools, runTool } from '../src/server/nl/tools.ts';

const NOW = Date.parse('2026-10-07T12:00:00Z');
const H = 3_600_000;
const DAY = 24 * H;

function fixture() {
  const db = new Db(':memory:');
  const r = parseWithRules('BTC 最近 10 秒主动买入金额超过主动卖出金额 3 倍时调用我的 webhook');
  if ('error' in r) throw new Error(r.error);
  const hook = db.insertWebhook({
    name: 'my-hook', url: 'https://hooks.example.com/x?token=leak', method: 'POST',
    headers: { Authorization: 'Bearer header-leak' }, secret: 'secret-leak', timeout_ms: 5000, max_retries: 3,
  });
  const sid = db.insertSignal(r.spec, hook, 'src');
  const leaves = [{ expr: 'a > b', left_metric: 'a', left: 300000, operator: '>', right_expr: 'b × 3', right: 90000, passed: true }];
  for (const ts of [NOW - 2 * H, NOW - 2 * H + 60_000, NOW - 30 * DAY]) {
    const id = db.insertEvent({
      signal_id: sid, signal_version: 1, ts, local_ts: ts, symbol: 'BTCUSDT', snapshot: { a: 300000 },
      condition: { passed: true, complete: true, leaves }, spec: r.spec, delivery_status: 'failed',
    });
    db.insertDelivery({ event_id: id, webhook_id: hook, attempt: 1, ts, ok: false, http_status: 500, latency_ms: 12, error: 'HTTP 500', is_test: false });
  }
  db.insertPoints([
    { symbol: 'BTCUSDT', metric: 'return_60s', ts: NOW - 10 * 60_000, value: 0.001 },
    { symbol: 'BTCUSDT', metric: 'return_60s', ts: NOW - 5 * 60_000, value: 0.004 },
    { symbol: 'BTCUSDT', metric: 'return_60s', ts: NOW - 60_000, value: -0.002 },
  ]);
  const runtime: ToolDeps['runtime'] = {
    symbols: () => [
      { symbol: 'BTCUSDT', ready_60s: true, buffer: 1, last_trade: { a: 1, p: 60000, q: 1, T: NOW, m: false }, exchange_now: NOW, ticker_24h: { last: 60000, high: 61000, low: 59000, change_pct: 0.0123, E: NOW } },
      { symbol: 'ETHUSDT', ready_60s: false, buffer: 1, last_trade: null, exchange_now: NOW, ticker_24h: null },
    ],
    snapshot: (symbol, names) =>
      Object.fromEntries(
        names.map((n) => [n, symbol === 'BTCUSDT' ? ({ buy_notional_10s: 500, return_5m: 0.025, ticker_quote_volume_24h: 1.5e9 } as Record<string, number>)[n] ?? null : null]),
      ),
    status: () => null,
  };
  const deps: ToolDeps = { runtime, db, retentionDays: 7, now: () => NOW, tz: 'Asia/Shanghai' };
  return { db, deps, sid };
}

const call = (deps: ToolDeps, name: string, args: unknown) => runTool(name, JSON.stringify(args), deps);

test('tools: 每个工具都能声明为 JSON Schema', async () => {
  const ts = llmTools();
  assert.equal(ts.length, TOOLS.length);
  for (const t of ts) assert.equal((t.function.parameters as any).type, 'object');
});

test('tools: snapshot 百分比换算、null 不补 0、未订阅拒答', async () => {
  const { deps } = fixture();
  const r = (await call(deps, 'market_snapshot', { symbol: 'btcusdt', metrics: ['return_5m', 'buy_notional_10s', 'sell_notional_10s'] }));
  assert.ok(r.ok);
  const m = (r.result as any).metrics;
  assert.deepEqual(m.return_5m, { value: 2.5, unit: '%' });
  assert.deepEqual(m.buy_notional_10s, { value: 500, unit: 'USDT' });
  assert.equal(m.sell_notional_10s.value, null);
  assert.equal(((await call(deps, 'market_snapshot', { symbol: 'SOLUSDT' })).result as any).error, 'not_subscribed');
  assert.equal(((await call(deps, 'market_snapshot', { symbol: 'BTCUSDT', metrics: ['nope'] })).result as any).error, 'unknown_metric');
});

test('tools: rank_symbols 把无数据的交易对单列', async () => {
  const { deps } = fixture();
  const r = (await call(deps, 'rank_symbols', { metric: 'buy_notional_10s' })).result as any;
  assert.deepEqual(r.ranking.map((x: any) => x.symbol), ['BTCUSDT']);
  assert.deepEqual(r.unavailable, ['ETHUSDT']);
});

test('tools: metric_stats 统计 + 超出保留期拒答（不给部分结果）', async () => {
  const { deps } = fixture();
  const r = (await call(deps, 'metric_stats', { symbol: 'BTCUSDT', metric: 'return_60s', lookback_minutes: 60 }));
  assert.ok(r.ok);
  const s = r.result as any;
  assert.equal(s.max.value, 0.4);
  assert.equal(s.min.value, -0.2);
  assert.equal(s.last.value, -0.2);
  assert.equal(s.unit, '%');
  assert.equal(s.max.at, '2026-10-07 19:55:00');
  const old = (await call(deps, 'metric_stats', { symbol: 'BTCUSDT', metric: 'return_60s', lookback_minutes: 8 * 1440 }));
  assert.equal(old.ok, false);
  assert.equal((old.result as any).error, 'insufficient_data');
  assert.equal(((await call(deps, 'metric_stats', { symbol: 'SOLUSDT', metric: 'return_60s', lookback_minutes: 60 })).result as any).error, 'no_data');
});

test('tools: 事件永久保留，超过 7 天也能统计；按小时分桶用用户时区', async () => {
  const { deps, sid } = fixture();
  const r = (await call(deps, 'event_stats', { lookback_minutes: 60 * 1440, by_hour: true })).result as any;
  assert.equal(r.total, 3);
  assert.equal(r.per_signal[0].signal_id, sid);
  assert.ok(r.per_signal[0].title);
  assert.deepEqual(r.by_hour.at(-1), { hour: '2026-10-07 18:00', count: 2 });
  const recent = (await call(deps, 'list_events', { lookback_minutes: 180 })).result as any;
  assert.equal(recent.events.length, 2);
  assert.equal(recent.events[0].leaves[0].left, 300000);
});

test('tools: 输出不含 webhook url / headers / secret', async () => {
  const { deps, sid } = fixture();
  const all = [
    ...(await Promise.all(TOOLS.map((t) => call(deps, t.name, { symbol: 'BTCUSDT', metric: 'return_60s', id: sid, lookback_minutes: 60 * 1440 })))),
    (await call(deps, 'delivery_failures', { lookback_minutes: 60 * 1440 })),
  ];
  const text = JSON.stringify(all);
  for (const leak of ['secret-leak', 'header-leak', 'token=leak', 'hooks.example.com']) assert.ok(!text.includes(leak), leak);
  const f = (await call(deps, 'delivery_failures', { lookback_minutes: 180 })).result as any;
  assert.equal(f.failures[0].webhook, 'my-hook');
  assert.equal(f.failures[0].http_status, 500);
});

test('tools: 参数错误作为结果回灌而不是抛出', async () => {
  const { deps } = fixture();
  assert.equal(((await runTool('metric_stats', '{"symbol":1}', deps)).result as any).error, 'bad_args');
  assert.equal(((await runTool('metric_stats', 'not json', deps)).result as any).error, 'bad_args');
  assert.equal(((await runTool('drop_table', '{}', deps)).result as any).error, 'unknown_tool');
  assert.equal(((await call(deps, 'event_stats', {})).result as any).error, 'bad_args');
});

test('tools: list_symbols 带 24h 成交额', async () => {
  const { deps } = fixture();
  const r = (await call(deps, 'list_symbols', {})).result as any;
  assert.equal(r.symbols[0].ticker_24h.quote_volume, 1.5e9);
  assert.equal(r.symbols[0].ticker_24h.change_pct, 1.23);
});

test('tools: search_binance_symbols 区分"可监控"与"已订阅"', async () => {
  const { deps } = fixture();
  deps.directory = {
    list: async () => [
      { symbol: 'BTCUSDT', base: 'BTC', quote: 'USDT' },
      { symbol: 'XPLUSDT', base: 'XPL', quote: 'USDT' },
      { symbol: 'XPLBTC', base: 'XPL', quote: 'BTC' },
      { symbol: 'ETHBTC', base: 'ETH', quote: 'BTC' },
    ],
  };
  const r = (await call(deps, 'search_binance_symbols', { query: 'xpl', quote: 'usdt' })).result as any;
  assert.equal(r.total_trading_spot, 4);
  assert.equal(r.in_quote, 2);
  assert.deepEqual(r.matches, [{ symbol: 'XPLUSDT', subscribed: false }]);
  assert.deepEqual(r.subscribed, ['BTCUSDT', 'ETHUSDT']);
  // 带 query 不指定 quote 时跨所有计价币
  const any = (await call(deps, 'search_binance_symbols', { query: 'XPL' })).result as any;
  assert.equal(any.match_count, 2);
  // 0 命中给近似建议
  const miss = (await call(deps, 'search_binance_symbols', { query: 'XPK' })).result as any;
  assert.equal(miss.match_count, 0);
  assert.deepEqual(miss.similar, ['XPL']);
  // list=true 返回完整清单（默认 USDT）
  const list = (await call(deps, 'search_binance_symbols', { list: true })).result as any;
  assert.deepEqual(list.symbols, ['BTCUSDT', 'XPLUSDT']);
  const listAll = (await call(deps, 'search_binance_symbols', { list: true, quote: 'ALL' })).result as any;
  assert.equal(listAll.symbols.length, 4);
  deps.directory = { list: async () => Promise.reject(new Error('offline')) };
  assert.equal(((await call(deps, 'search_binance_symbols', {})).result as any).error, 'unavailable');
});

test('symbols: exchangeInfo 只保留 TRADING，缓存 1 小时，失败沿用旧缓存', async () => {
  let n = 0;
  let fail = false;
  let now = 0;
  const fake = (async () => {
    n++;
    if (fail) throw new Error('down');
    return new Response(JSON.stringify({ symbols: [
      { symbol: 'BTCUSDT', baseAsset: 'BTC', quoteAsset: 'USDT', status: 'TRADING' },
      { symbol: 'OLDUSDT', baseAsset: 'OLD', quoteAsset: 'USDT', status: 'BREAK' },
    ] }));
  }) as typeof fetch;
  const dir = new SymbolDirectory('https://x', fake, () => now);
  assert.deepEqual((await dir.list()).map((s) => s.symbol), ['BTCUSDT']);
  await dir.list();
  assert.equal(n, 1);
  now = 2 * H;
  fail = true;
  assert.equal((await dir.list()).length, 1);
  assert.equal(n, 2);
  await assert.rejects(new SymbolDirectory('https://x', fake).list());
});

// ---------- 对话循环 ----------

function scripted(replies: LlmMessage[]) {
  const seen: { messages: LlmMessage[]; opts?: LlmOptions }[] = [];
  const fn: LlmCall = async (messages, opts) => {
    seen.push({ messages: structuredClone(messages), opts });
    const r = replies.shift();
    if (!r) throw new Error('script exhausted');
    return r;
  };
  return { fn, seen };
}
const toolCall = (id: string, name: string, args: unknown): LlmMessage => ({
  role: 'assistant', content: null, tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }],
});

test('chat: 工具调用 → 回答；关闭思考；trace 与 digest', async () => {
  const { deps } = fixture();
  const { fn, seen } = scripted([
    toolCall('c1', 'market_snapshot', { symbol: 'BTCUSDT', metrics: ['buy_notional_10s'] }),
    { role: 'assistant', content: '<think>x</think>BTC 10s 主动买入 500 USDT' },
  ]);
  const r = await runChat([{ role: 'user', content: 'BTC 买盘多少' }], { call: fn, tools: deps });
  assert.equal(r.answer, 'BTC 10s 主动买入 500 USDT');
  assert.equal(r.trace.length, 1);
  assert.ok(r.trace[0].ok);
  assert.match(r.digest, /market_snapshot/);
  assert.equal(seen[0].opts?.thinking, false);
  assert.ok(seen[0].opts?.tools?.length);
  const toolMsg = seen[1].messages.at(-1)!;
  assert.equal(toolMsg.role, 'tool');
  assert.equal(toolMsg.tool_call_id, 'c1');
  assert.match(seen[0].messages[0].content!, /Asia\/Shanghai/);
});

test('chat: 参数错误回灌后模型可自行修正', async () => {
  const { deps } = fixture();
  const { fn, seen } = scripted([
    toolCall('c1', 'metric_stats', { symbol: 'BTCUSDT' }),
    toolCall('c2', 'metric_stats', { symbol: 'BTCUSDT', metric: 'return_60s', lookback_minutes: 60 }),
    { role: 'assistant', content: 'ok' },
  ]);
  const r = await runChat([{ role: 'user', content: 'q' }], { call: fn, tools: deps });
  assert.deepEqual(r.trace.map((t) => t.ok), [false, true]);
  assert.match(seen[1].messages.at(-1)!.content!, /bad_args/);
});

test('chat: 步数用完后不再给工具，逼模型作答', async () => {
  const { deps } = fixture();
  const loops = Array.from({ length: MAX_ROUNDS }, (_, i) => toolCall(`c${i}`, 'list_symbols', {}));
  const { fn, seen } = scripted([...loops, { role: 'assistant', content: 'final' }]);
  const r = await runChat([{ role: 'user', content: 'q' }], { call: fn, tools: deps });
  assert.equal(r.answer, 'final');
  assert.equal(seen.length, MAX_ROUNDS + 1);
  assert.equal(seen.at(-1)!.opts?.tools, undefined);
});

test('chat: 历史中的 digest 回传给模型；截断后首条必须是 user', async () => {
  const { deps } = fixture();
  const { fn, seen } = scripted([{ role: 'assistant', content: 'ok' }]);
  await runChat(
    [
      { role: 'user', content: 'BTC 买盘多少' },
      { role: 'assistant', content: '500 USDT', digest: 'market_snapshot(...) → {"buy_notional_10s":500}' },
      { role: 'user', content: '超过现在 3 倍提醒我' },
    ],
    { call: fn, tools: deps },
  );
  assert.match(seen[0].messages[2].content!, /buy_notional_10s":500/);

  const long: ChatTurn[] = Array.from({ length: 30 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: `m${i}` }));
  const t = trimHistory(long);
  assert.ok(t.length <= 20);
  assert.equal(t[0].role, 'user');
  assert.equal(t.at(-1)!.content, 'm29');
  await assert.rejects(runChat([{ role: 'assistant', content: 'x' }], { call: fn, tools: deps }));
});

test('llm: thinking 参数只发给认识它的端点', async () => {
  const base = { baseUrl: 'https://api.deepseek.com', apiKey: 'k', model: 'deepseek-flash' };
  assert.deepEqual(buildRequestBody({ ...base, thinkingParam: true }, [], { thinking: false }).thinking, { type: 'disabled' });
  assert.deepEqual(buildRequestBody({ ...base, thinkingParam: true }, [], { thinking: true }).thinking, { type: 'enabled' });
  assert.equal(buildRequestBody({ ...base, thinkingParam: false }, [], { thinking: true }).thinking, undefined);
  assert.equal(buildRequestBody(base, [], {}).tools, undefined);
});
