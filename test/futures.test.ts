import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import { BinanceHub, MarketHub } from '../src/server/binance/stream.ts';
import { Db } from '../src/server/db.ts';
import { Runtime } from '../src/server/engine/runtime.ts';
import type { SymbolWindows } from '../src/server/engine/window.ts';
import { detectProduct, parseWithRules } from '../src/server/nl/rules.ts';
import type { WebhookDispatcher } from '../src/server/webhook/delivery.ts';
import { marketKey, parseMarketKey, validateSpec } from '../src/shared/dsl.ts';

test('dsl: product 支持 futures，旧 spot spec 不变；市场键 .P 往返', () => {
  const r = parseWithRules('BTC 最近 10 秒主动买入金额超过主动卖出金额 3 倍');
  if ('error' in r) throw new Error(r.error);
  assert.equal(r.spec.market.product, 'spot');
  assert.ok(validateSpec(r.spec).ok);
  const fut = { ...r.spec, market: { ...r.spec.market, product: 'futures' } };
  assert.ok(validateSpec(fut).ok);
  assert.ok(!validateSpec({ ...r.spec, market: { ...r.spec.market, product: 'coinm' } }).ok);
  assert.equal(marketKey({ product: 'futures', symbol: 'BTCUSDT' }), 'BTCUSDT.P');
  assert.equal(marketKey({ product: 'spot', symbol: 'BTCUSDT' }), 'BTCUSDT');
  assert.deepEqual(parseMarketKey('QQQUSDT.P'), { product: 'futures', symbol: 'QQQUSDT' });
  assert.deepEqual(parseMarketKey('BTCUSDT'), { product: 'spot', symbol: 'BTCUSDT' });
});

test('rules: 合约 / 永续 / perp 识别为 futures，symbol 保持交易所原始写法，名称加 -perp', () => {
  assert.equal(detectProduct('BTC 合约 10 秒涨 1%'), 'futures');
  assert.equal(detectProduct('ETH perp 24h 新低'), 'futures');
  assert.equal(detectProduct('BTCUSDT.P 5 秒跌 0.3%'), 'futures');
  assert.equal(detectProduct('BTC 10 秒涨 1%'), 'spot');
  const r = parseWithRules('BTC 永续 10 秒主动买入超过卖出 3 倍');
  if ('error' in r) throw new Error(r.error);
  assert.deepEqual(r.spec.market, { exchange: 'binance', product: 'futures', symbol: 'BTCUSDT' });
  assert.match(r.spec.name, /^btc-perp-/);
  const p = parseWithRules('BTCUSDT.P 5 秒跌 0.3%');
  if ('error' in p) throw new Error(p.error);
  assert.equal(p.spec.market.symbol, 'BTCUSDT');
  assert.equal(p.spec.market.product, 'futures');
});

test('stream: 合约连接把交易所 symbol 转成 .P 市场键；流名不带后缀', () => {
  const hub = new BinanceHub('wss://x', 'futures');
  (hub as any).addState('BTCUSDT.P');
  const got: string[] = [];
  hub.on('trade', (s) => got.push(`trade:${s}`));
  hub.on('ticker', (s) => got.push(`ticker:${s}`));
  // 合约 aggTrade 无 M 字段、带 st；24hrTicker 无 x/b/a 等字段——解析只用两边共有的字段
  (hub as any).onMessage(JSON.stringify({ stream: 'btcusdt@aggTrade', data: { e: 'aggTrade', E: 2, s: 'BTCUSDT', a: 1, p: '100', q: '2', f: 1, l: 1, T: 1, m: false, st: 1 } }));
  (hub as any).onMessage(JSON.stringify({ stream: 'btcusdt@ticker', data: {
    e: '24hrTicker', E: 3, s: 'BTCUSDT', p: '1', P: '1', w: '1', c: '100', Q: '1', o: '99', h: '101', l: '98', v: '10', q: '1000', O: 0, C: 1, F: 0, L: 1, n: 2,
  } }));
  assert.deepEqual(got, ['trade:BTCUSDT.P', 'ticker:BTCUSDT.P']);
  assert.equal(hub.samples('BTCUSDT.P', 'aggTrade').length, 1);
  assert.equal(hub.getStatus().product, 'futures');
});

test('stream: 无订阅时不建立连接（合约按需连接，避免空连接被假死检测反复重连）', () => {
  const hub = new MarketHub('wss://spot.invalid', 'wss://fut.invalid');
  const orig = globalThis.WebSocket;
  const opened: string[] = [];
  globalThis.WebSocket = class {
    static OPEN = 1;
    readyState = 0;
    constructor(url: string) {
      opened.push(url);
    }
    close() {}
    send() {}
  } as any;
  try {
    hub.start(['BTCUSDT']);
    assert.equal(opened.length, 1);
    assert.match(opened[0], /^wss:\/\/spot\.invalid\/stream\?streams=btcusdt@aggTrade\/btcusdt@ticker$/);
    hub.ensure('ETHUSDT.P');
    assert.equal(opened.length, 2);
    assert.match(opened[1], /^wss:\/\/fut\.invalid\/stream\?streams=ethusdt@aggTrade\/ethusdt@ticker$/);
    hub.release('ETHUSDT.P');
    assert.equal(hub.hubs.futures.getStatus().status, 'disconnected');
  } finally {
    hub.stop();
    globalThis.WebSocket = orig;
  }
});

test('runtime: 一个市场断线只作废该市场的窗口，同名另一市场照常连续（不变量 4）', () => {
  const hub = Object.assign(new EventEmitter(), { start() {}, stop() {}, ensure() {}, release() {} });
  const rt = new Runtime(new Db(':memory:'), hub as any, {} as WebhookDispatcher, ['BTCUSDT', 'BTCUSDT.P'], 7);
  rt.sync();
  hub.emit('connected', ['BTCUSDT'], 0);
  hub.emit('connected', ['BTCUSDT.P'], 0);
  for (const k of ['BTCUSDT', 'BTCUSDT.P']) {
    hub.emit('trade', k, { a: 1, T: 0, p: 100, q: 1, m: false }, 0, Date.now());
    hub.emit('trade', k, { a: 2, T: 10_000, p: 100, q: 1, m: false }, 10_000, Date.now());
  }
  const win = (k: string) => (rt as any).windows.get(k) as SymbolWindows;
  assert.ok(win('BTCUSDT').ready(5_000));
  assert.ok(win('BTCUSDT.P').ready(5_000));
  hub.emit('disconnected', 'closed', ['BTCUSDT.P']);
  assert.ok(win('BTCUSDT').ready(5_000));
  assert.ok(!win('BTCUSDT.P').ready(5_000));
});
