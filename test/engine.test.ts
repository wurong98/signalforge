import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { MetricDef, SignalSpec } from '../src/shared/dsl.ts';
import { validateSpec } from '../src/shared/dsl.ts';
import { SignalStateMachine, evaluateCondition, gauge } from '../src/server/engine/signal.ts';
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
