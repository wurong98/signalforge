import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { MetricDef, SignalSpec } from '../src/shared/dsl.ts';
import { describeFormula, metricUnit, validateSpec } from '../src/shared/dsl.ts';
import { SignalStateMachine, evaluateCondition, gauge, requiresTicker, requiredWindowMs } from '../src/server/engine/signal.ts';
import type { Ticker } from '../src/server/engine/window.ts';
import { SymbolWindows } from '../src/server/engine/window.ts';

const buy10: MetricDef = { name: 'buy', kind: 'window', stream: 'aggTrade', window: '10s', filter: { buyer_is_maker: false }, field: 'notional', aggregation: 'sum' };
const sell10: MetricDef = { name: 'sell', kind: 'window', stream: 'aggTrade', window: '10s', filter: { buyer_is_maker: true }, field: 'notional', aggregation: 'sum' };
const ret5: MetricDef = { name: 'ret', kind: 'window', stream: 'aggTrade', window: '5s', filter: {}, field: 'price', aggregation: 'return' };
const cnt: MetricDef = { name: 'cnt', kind: 'window', stream: 'aggTrade', window: '10s', filter: {}, field: 'notional', aggregation: 'count' };
const ratio: MetricDef = { name: 'ratio', kind: 'combine', op: 'ratio', a: 'buy', b: 'sell' };

let aid = 0;
const trade = (T: number, p: number, q: number, m: boolean) => ({ a: aid++, T, p, q, m });

test('window: sums split by buyer_is_maker and slide by trade time', () => {
  const w = new SymbolWindows();
  w.markContinuous(0);
  w.push(trade(1_000, 100, 1, false)); // buy 100
  w.push(trade(2_000, 100, 2, true)); // sell 200
  w.push(trade(5_000, 110, 1, false)); // buy 110
  w.advance(10_500);
  assert.deepEqual(w.evaluate([buy10, sell10, cnt, ratio]), { buy: 210, sell: 200, cnt: 3, ratio: 1.05 });
  w.advance(11_500); // 1s 处的成交滑出（T <= now - 10s）
  assert.deepEqual(w.evaluate([buy10, sell10]), { buy: 110, sell: 200 });
  w.advance(20_000);
  assert.deepEqual(w.evaluate([buy10, sell10, cnt, ratio]), { buy: 0, sell: 0, cnt: 0, ratio: null });
});

test('window: return / first / last, null when window empty', () => {
  const w = new SymbolWindows();
  w.markContinuous(0);
  w.push(trade(6_000, 100, 1, false));
  w.push(trade(7_000, 101, 1, true));
  w.push(trade(8_000, 102, 1, false));
  w.advance(10_000);
  assert.equal(w.evaluate([ret5]).ret, 0.02);
  w.advance(20_000);
  assert.equal(w.evaluate([ret5]).ret, null);
});

test('window: not ready until continuous for full window (warmup / reconnect)', () => {
  const w = new SymbolWindows();
  w.markContinuous(1_000);
  w.push(trade(1_000, 100, 1, false));
  w.advance(5_000);
  assert.equal(w.evaluate([buy10]).buy, null);
  w.advance(11_000);
  assert.equal(w.evaluate([buy10]).buy, 0); // 1s 的成交刚好滑出
  w.markDisconnected();
  assert.equal(w.evaluate([buy10]).buy, null);
});

test('window: accumulator created late backfills from buffer', () => {
  const w = new SymbolWindows();
  w.markContinuous(0);
  w.evaluate([cnt]); // 先建 count 累加器，保证缓冲区保留成交
  for (let t = 1_000; t <= 9_000; t += 1_000) w.push(trade(t, 10, 1, t % 2000 === 0));
  w.advance(10_000);
  assert.deepEqual(w.evaluate([buy10, sell10]), { buy: 50, sell: 40 });
});

test('window: many trades with compaction keep running sum exact', () => {
  const w = new SymbolWindows();
  w.markContinuous(0);
  w.evaluate([buy10]);
  for (let t = 1; t <= 200_000; t++) {
    w.push(trade(t, 1, 1, false));
    if (t % 100 === 0) w.advance(t);
  }
  assert.equal(w.evaluate([buy10]).buy, 10_000);
  assert.ok(w.bufferSize < 80_000);
});

test('condition: multiplier form, AND/OR, ratio in explain', () => {
  const r = evaluateCondition({ left: 'buy', operator: '>', right: { metric: 'sell', multiplier: 3 } }, { buy: 9.21, sell: 2.82 });
  assert.equal(r.passed, true);
  assert.equal(r.leaves[0].ratio!.toFixed(2), '3.27');
  assert.deepEqual(gauge(r), { value: r.leaves[0].ratio, threshold: 3, kind: 'ratio' });
  const and = evaluateCondition(
    { op: 'and', conditions: [{ left: 'buy', operator: '>', right: { metric: 'sell', multiplier: 3 } }, { left: 'ret', operator: '>', right: { value: 0.001 } }] },
    { buy: 9, sell: 2, ret: 0.0005 },
  );
  assert.equal(and.passed, false);
  assert.equal(evaluateCondition({ left: 'buy', operator: '>', right: { value: 1 } }, { buy: null }).passed, false);
});

test('state machine: fires only on false→true edge, respects cooldown', () => {
  const sm = new SignalStateMachine(10_000);
  const fires: number[] = [];
  const step = (t: number, passed: boolean, ready = true) => sm.step(t, ready, passed).fire && fires.push(t);
  step(0, true, false); // warming
  step(1_000, true); // 就绪时已为真：未观测到边沿，不触发
  assert.equal(sm.state, 'ACTIVE');
  step(2_000, false);
  step(3_000, true); // 边沿 → 触发
  step(4_000, false);
  step(5_000, true); // 冷却中
  step(14_000, true); // 冷却结束仍为真 → ACTIVE，不触发
  assert.equal(sm.state, 'ACTIVE');
  step(15_000, false);
  step(16_000, true); // 新边沿 → 触发
  step(17_000, true);
  assert.deepEqual(fires, [3_000, 16_000]);
  step(18_000, false, false);
  assert.equal(sm.state, 'WARMING');
});

test('validateSpec: rejects dangling references and bad aggregations', () => {
  const base: SignalSpec = {
    name: 'x', title: 'x', description: '', cooldown_ms: 0,
    market: { exchange: 'binance', product: 'spot', symbol: 'BTCUSDT' },
    metrics: [buy10, sell10],
    condition: { left: 'buy', operator: '>', right: { metric: 'sell', multiplier: 3 } },
  };
  assert.equal(validateSpec(base).ok, true);
  const r1 = validateSpec({ ...base, condition: { left: 'nope', operator: '>', right: { value: 1 } } });
  assert.equal(r1.ok, false);
  const r2 = validateSpec({ ...base, metrics: [ratio, buy10, sell10] });
  assert.equal(r2.ok, false);
  const r3 = validateSpec({ ...base, metrics: [{ ...buy10, aggregation: 'return' }, sell10] });
  assert.equal(r3.ok, false);
  const r4 = validateSpec({ ...base, market: { ...base.market, symbol: 'btc; drop' } });
  assert.equal(r4.ok, false);
});

// ---------- 24h ticker 指标（方案 A） ----------

const low24: MetricDef = { name: 'low_24h', kind: 'ticker', stream: 'ticker', field: 'low_24h' };
const high24: MetricDef = { name: 'high_24h', kind: 'ticker', stream: 'ticker', field: 'high_24h' };
const pct24: MetricDef = { name: 'change_pct_24h', kind: 'ticker', stream: 'ticker', field: 'change_pct_24h' };
const last1s: MetricDef = { name: 'last_1s', kind: 'window', stream: 'aggTrade', window: '1s', filter: {}, field: 'price', aggregation: 'last' };

const ticker = (o: Partial<Ticker>): Ticker => ({ E: 0, last: 0, high: 0, low: 0, change: 0, changePct: 0, volume: 0, quoteVolume: 0, ...o });

test('ticker: null until first snapshot, then exchange-side 24h values, no warmup', () => {
  const w = new SymbolWindows();
  w.markContinuous(0);
  w.advance(10_000);
  assert.equal(w.ticker24h, null);
  assert.deepEqual(w.evaluate([low24, high24, pct24]), { low_24h: null, high_24h: null, change_pct_24h: null });

  w.pushTicker(ticker({ low: 61_000.5, high: 64_200, last: 62_000, changePct: 2.345 / 100, quoteVolume: 1.8e9 }));
  // 无窗口预热：ticker 第一条即有效
  const v = w.evaluate([low24, high24, pct24]);
  assert.equal(v.low_24h, 61_000.5);
  assert.equal(v.high_24h, 64_200);
  assert.equal(v.change_pct_24h!.toFixed(5), '0.02345');
  assert.equal(w.ready(60_000), false); // 但窗口指标仍需各自预热
});

test('ticker: percent is normalized to a fraction, and combines over ticker work', () => {
  const w = new SymbolWindows();
  w.pushTicker(ticker({ low: 100, high: 120, changePct: -3.5 / 100 }));
  const down: MetricDef = { name: 'from_high', kind: 'combine', op: 'diff', a: 'high_24h', b: 'low_24h' };
  const ratio: MetricDef = { name: 'pos', kind: 'combine', op: 'ratio', a: 'low_24h', b: 'high_24h' };
  assert.equal(w.evaluate([pct24]).change_pct_24h!.toFixed(5), '-0.03500');
  assert.equal(w.evaluate([high24, low24, down]).from_high, 20);
  assert.equal(w.evaluate([high24, low24, ratio]).pos!.toFixed(4), '0.8333');
  assert.equal(metricUnit(pct24, [pct24]), '%');
  assert.equal(metricUnit(low24, [low24]), 'USDT');
  assert.match(describeFormula(low24), /TICKER\.l/);
  assert.match(describeFormula(pct24), /TICKER\.P \/ 100/);
});

test('validateSpec: accepts ticker metrics alongside window metrics', () => {
  const spec = {
    name: 'btc-24h-new-low', title: 'BTC 24h New Low', description: '', cooldown_ms: 60_000,
    market: { exchange: 'binance', product: 'spot', symbol: 'BTCUSDT' },
    metrics: [last1s, low24],
    condition: { left: 'last_1s', operator: '<' as const, right: { metric: 'low_24h', multiplier: 1 } },
  };
  const v = validateSpec(spec);
  assert.equal(v.ok, true);
  assert.equal(requiresTicker(v.ok ? v.spec : (spec as unknown as SignalSpec)), true);
  assert.equal(requiresTicker({ ...spec, metrics: [last1s] } as unknown as SignalSpec), false);
  assert.equal(requiredWindowMs(v.ok ? v.spec : (spec as unknown as SignalSpec)), 1_000);
  // 已存库的 V1 spec（无 ticker）语义不变
  assert.equal(validateSpec({ ...spec, metrics: [buy10, sell10], condition: { left: 'buy', operator: '>', right: { metric: 'sell', multiplier: 3 } } }).ok, true);
  // 引用未定义的 ticker 指标必须报错
  assert.equal(validateSpec({ ...spec, condition: { left: 'last_1s', operator: '<', right: { metric: 'nope', multiplier: 1 } } }).ok, false);
});

/** 复刻 Runtime.evaluateSymbol 的就绪判定：窗口预热完 且（若用 ticker）已收到第一条 ticker */
const drive = (w: SymbolWindows, spec: SignalSpec) => {
  const needMs = requiredWindowMs(spec);
  const needTicker = requiresTicker(spec);
  const sm = new SignalStateMachine(spec.cooldown_ms);
  const fires: number[] = [];
  return {
    state: () => sm.state,
    step(now: number) {
      w.advance(now); // 与 Runtime 的 200ms tick 一致：先按交易所时间推进窗口再求值
      const v = w.evaluate(spec.metrics);
      const ready = w.ready(needMs) && (!needTicker || w.ticker24h !== null);
      if (sm.step(now, ready, evaluateCondition(spec.condition, v).passed).fire) fires.push(now);
    },
    fires,
  };
};

const newLowSpec = (cooldown_ms = 60_000): SignalSpec => ({
  name: 'btc-24h-new-low', title: 'BTC 24h New Low', description: '', cooldown_ms,
  market: { exchange: 'binance', product: 'spot', symbol: 'BTCUSDT' },
  metrics: [last1s, low24],
  condition: { left: 'last_1s', operator: '<', right: { metric: 'low_24h', multiplier: 1 } },
});

test('24h new low: fires once per new-low edge, rate limited by cooldown', () => {
  const w = new SymbolWindows();
  w.markContinuous(0);
  const d = drive(w, newLowSpec());

  d.step(500); // 1s 窗口未预热
  assert.equal(d.state(), 'WARMING');

  w.push(trade(1_000, 100, 1, false));
  w.pushTicker(ticker({ low: 100 }));
  d.step(1_000);
  // 启动时价格正好等于 24h 低：严格小于不成立 → ARMED，而不是把"已满足"当成边沿
  assert.equal(d.state(), 'ARMED');
  assert.deepEqual(d.fires, []);

  w.push(trade(1_100, 99, 1, false)); // 跌破 100，创 24h 新低
  d.step(1_100);
  assert.deepEqual(d.fires, [1_100]);
  assert.equal(d.state(), 'COOLDOWN');

  w.pushTicker(ticker({ low: 99 })); // ticker 跟���到新低，条件解除
  d.step(1_200);
  w.push(trade(1_300, 98.5, 1, false)); // 连续创新低，但仍在冷却内
  d.step(1_300);
  assert.deepEqual(d.fires, [1_100]);

  d.step(61_100); // 冷却到期
  assert.equal(d.state(), 'ARMED');
  w.push(trade(61_200, 98, 1, false));
  d.step(61_200); // 又一次创新低 → 再触发
  assert.deepEqual(d.fires, [1_100, 61_200]);
});

test('ticker-only signal: waits for the first ticker, so an already-true 24h change does not fire on startup', () => {
  const w = new SymbolWindows();
  w.markContinuous(0);
  const spec: SignalSpec = {
    name: 'btc-24h-pump-5pct', title: 'BTC 24h Rise 5%', description: '', cooldown_ms: 60_000,
    market: { exchange: 'binance', product: 'spot', symbol: 'BTCUSDT' },
    metrics: [pct24],
    condition: { left: 'change_pct_24h', operator: '>=', right: { value: 0.05 } },
  };
  const d = drive(w, spec);

  w.push(trade(1_000, 100, 1, false));
  d.step(1_000);
  // 没有窗口指标、连接已就绪，但 ticker 还没来：仍不算就绪
  assert.equal(d.state(), 'WARMING');

  w.pushTicker(ticker({ changePct: 0.08 })); // 启动时就已经满足 24h 涨跌幅 > 5%
  d.step(1_100);
  assert.equal(d.state(), 'ACTIVE');
  assert.deepEqual(d.fires, [], '启动时已满足的条件不触发');

  d.step(61_200); // 冷却分支不适用，ACTIVE 下条件仍为真
  assert.deepEqual(d.fires, []);

  w.pushTicker(ticker({ changePct: 0.01 })); // 回落到 5% 以下
  d.step(62_000);
  assert.equal(d.state(), 'ARMED');
  w.pushTicker(ticker({ changePct: 0.06 })); // 再次突破
  d.step(62_100);
  assert.deepEqual(d.fires, [62_100]);
});
