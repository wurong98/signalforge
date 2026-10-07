import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import type { SignalSpec } from '../src/shared/dsl.ts';
import { validateSpec } from '../src/shared/dsl.ts';
import { Db } from '../src/server/db.ts';
import { extractJson, parseNaturalLanguage } from '../src/server/nl/parse.ts';
import { parseWithRules } from '../src/server/nl/rules.ts';
import { WebhookDispatcher, isPrivateAddress, sign } from '../src/server/webhook/delivery.ts';
import { checkFeishuResponse, feishuSign, toFeishuMessage } from '../src/server/webhook/feishu.ts';
import { isFeishuWebhook } from '../src/shared/webhook.ts';

test('rules: core demo sentence', () => {
  const r = parseWithRules('BTC 最近 10 秒主动买入金额超过主动卖出金额 3 倍时调用我的 webhook。');
  assert.ok(!('error' in r));
  assert.equal(r.spec.market.symbol, 'BTCUSDT');
  assert.deepEqual(r.spec.condition, {
    op: 'and',
    conditions: [
      { left: 'buy_notional_10s', operator: '>', right: { metric: 'sell_notional_10s', multiplier: 3 } },
      { left: 'buy_notional_10s', operator: '>=', right: { value: 50_000 } },
    ],
  });
  const buy = r.spec.metrics.find((m) => m.name === 'buy_notional_10s')!;
  assert.equal(buy.kind === 'window' && buy.filter.buyer_is_maker, false);
});

test('rules: sell side, percent move, nearest window', () => {
  const s = parseWithRules('ETH 30秒主动卖出是买入的 2.5 倍');
  assert.ok(!('error' in s));
  assert.equal(s.spec.market.symbol, 'ETHUSDT');
  assert.deepEqual((s.spec.condition as any).conditions[0], { left: 'sell_notional_30s', operator: '>', right: { metric: 'buy_notional_30s', multiplier: 2.5 } });
  assert.deepEqual((s.spec.condition as any).conditions[1], { left: 'sell_notional_30s', operator: '>=', right: { value: 60_000 } });
  const p = parseWithRules('SOLUSDT 5 秒内跌幅超过 0.3%');
  assert.ok(!('error' in p));
  assert.deepEqual(p.spec.condition, { left: 'return_5s', operator: '<=', right: { value: -0.003 } });
  const n = parseWithRules('BTC 7 秒涨 1%');
  assert.ok(!('error' in n));
  assert.equal(n.spec.metrics[0].kind === 'window' && n.spec.metrics[0].window, '5s');
  assert.ok(n.assumptions.length > 0);
  assert.ok('error' in parseWithRules('帮我看看天气'));
});

test('parse: falls back to rules without LLM', async () => {
  const r = await parseNaturalLanguage('BTC 10 秒主动买盘超过卖盘 3 倍时通知我', null);
  assert.ok(!('error' in r));
  assert.equal(r.parser, 'rules');
});

// ---------- 24h 档：走 @ticker，不退化成长度 ≤60s 的窗口 ----------

test('rules: 24h new low uses ticker, not a degraded 60s window', () => {
  const r = parseWithRules('BTC 创 24 小时新低时提醒我，每分钟最多一次');
  assert.ok(!('error' in r));
  assert.equal(r.spec.name, 'btc-24h-new-low');
  assert.equal(r.spec.market.symbol, 'BTCUSDT');
  assert.equal(r.spec.cooldown_ms, 60_000);
  assert.deepEqual(r.spec.metrics, [
    { name: 'last_1s', kind: 'window', stream: 'aggTrade', window: '1s', filter: {}, field: 'price', aggregation: 'last' },
    { name: 'low_24h', kind: 'ticker', stream: 'ticker', field: 'low_24h' },
  ]);
  // 严格小于：新成交价跌破 ticker 尚未更新的 24h 低点
  assert.deepEqual(r.spec.condition, { left: 'last_1s', operator: '<', right: { metric: 'low_24h', multiplier: 1 } });
  // 24h 档与窗口无关，不该被塞进"未指定时间窗口"的假设
  assert.ok(!r.assumptions.some((a) => a.includes('时间窗口')), r.assumptions.join(' | '));
  assert.equal(validateSpec(r.spec).ok, true);
});

test('rules: 24h new high is the mirror image', () => {
  const r = parseWithRules('ETH 一天内创新高时通知我，每 30 秒一次');
  assert.ok(!('error' in r));
  assert.equal(r.spec.name, 'eth-24h-new-high');
  assert.equal(r.spec.cooldown_ms, 30_000);
  assert.deepEqual(r.spec.metrics[1], { name: 'high_24h', kind: 'ticker', stream: 'ticker', field: 'high_24h' });
  assert.deepEqual(r.spec.condition, { left: 'last_1s', operator: '>', right: { metric: 'high_24h', multiplier: 1 } });
});

test('rules: 24h change percent, direction and two-sided', () => {
  const up = parseWithRules('BTC 24小时涨幅超过 5% 时提醒我');
  assert.ok(!('error' in up));
  assert.deepEqual(up.spec.metrics, [{ name: 'change_pct_24h', kind: 'ticker', stream: 'ticker', field: 'change_pct_24h' }]);
  assert.deepEqual(up.spec.condition, { left: 'change_pct_24h', operator: '>=', right: { value: 0.05 } });

  const down = parseWithRules('SOL 24小时跌幅超过 3% 时提醒我');
  assert.ok(!('error' in down));
  assert.deepEqual(down.spec.condition, { left: 'change_pct_24h', operator: '<=', right: { value: -0.03 } });

  // "涨跌幅" 不分方向 → 双向 OR
  const both = parseWithRules('BTC 24小时涨跌幅超过 2%');
  assert.ok(!('error' in both));
  assert.deepEqual(both.spec.condition, {
    op: 'or',
    conditions: [
      { left: 'change_pct_24h', operator: '>=', right: { value: 0.02 } },
      { left: 'change_pct_24h', operator: '<=', right: { value: -0.02 } },
    ],
  });
  for (const r of [up, down, both]) assert.equal(validateSpec(r.spec).ok, true);
});

test('rules: fractional percent yields a valid slug', () => {
  const r = parseWithRules('BTC 24小时涨幅超过2.5%');
  assert.ok(!('error' in r));
  assert.equal(r.spec.name, 'btc-24h-pump-2p5pct');
  assert.equal(validateSpec(r.spec).ok, true);
});

test('rules: cooldown needs a rate-limit phrase, supports hours', () => {
  const cd = (t: string) => {
    const r = parseWithRules(t);
    assert.ok(!('error' in r));
    return r.spec.cooldown_ms;
  };
  assert.equal(cd('BTC 创 24 小时新低时提醒我，每分钟最多一次'), 60_000);
  assert.equal(cd('BTC 创 24 小时新低，每 30 秒提醒一次'), 30_000);
  assert.equal(cd('BTC 24小时新低，每小时最多一次'), 3600_000);
  assert.equal(cd('BTC 24小时新低，冷却 2 小时'), 7200_000);
  // "每 30 秒" 描述的是统计口径，不是冷却 → 默认 10s
  assert.equal(cd('BTC 每 30 秒主动买入金额超过主动卖出金额 3 倍'), 10_000);
});

test('rules: english direction words need word boundaries', () => {
  const r = parseWithRules('BTC 24h change 5% after supply update');
  assert.ok(!('error' in r));
  assert.equal(r.spec.condition && 'op' in r.spec.condition ? r.spec.condition.op : null, 'or');
  const up = parseWithRules('BTC 24h up 5%');
  assert.ok(!('error' in up));
  assert.deepEqual(up.spec.condition, { left: 'change_pct_24h', operator: '>=', right: { value: 0.05 } });
});

test('rules: short-window sentences are unaffected by the 24h branch', () => {
  // "10 秒" 不含 24h，仍应走窗口分支
  const n = parseWithRules('BTC 7 秒涨 1%');
  assert.ok(!('error' in n));
  assert.equal(n.spec.metrics[0].kind === 'window' && n.spec.metrics[0].window, '5s');
  const b = parseWithRules('BTC 10 秒主动买入超过卖出 3 倍');
  assert.ok(!('error' in b));
  assert.equal(b.spec.metrics[0].kind, 'window');
});

test('rules: 分钟窗口映射到 5m，不再拼成非法的 300s', () => {
  const s = parseWithRules('XPL 5 分钟涨幅超过 3%');
  assert.ok(!('error' in s));
  assert.equal(s.spec.market.symbol, 'XPLUSDT');
  assert.deepEqual(s.spec.condition, { left: 'return_5m', operator: '>=', right: { value: 0.03 } });
  assert.ok(validateSpec(s.spec).ok);
  const n = parseWithRules('BTC 4 分钟涨 1%');
  assert.ok(!('error' in n));
  assert.equal(n.spec.metrics[0].kind === 'window' && n.spec.metrics[0].window, '5m');
  assert.ok(n.assumptions.some((a) => a.includes('5m')));
});

test('rules: 噪声下限按窗口毫秒缩放，5m = 30 × 10s', () => {
  const s = parseWithRules('XPL 5分钟主动买入是卖出的 2 倍');
  assert.ok(!('error' in s));
  assert.deepEqual((s.spec.condition as any).conditions[1], { left: 'buy_notional_5m', operator: '>=', right: { value: 150_000 } });
});

test('rules: 涨幅 + CVD 为正 → return_5m AND volume_delta_5m > 0，不会丢掉 CVD 条件', () => {
  const s = parseWithRules('XPL 5 分钟涨幅超过 2%，同时 CVD 为正');
  assert.ok(!('error' in s));
  assert.ok(validateSpec(s.spec).ok);
  assert.deepEqual(s.spec.condition, {
    op: 'and',
    conditions: [
      { left: 'return_5m', operator: '>=', right: { value: 0.02 } },
      { left: 'volume_delta_5m', operator: '>', right: { value: 0 } },
    ],
  });
  assert.deepEqual(s.spec.metrics.map((m) => m.name), ['buy_notional_5m', 'sell_notional_5m', 'volume_delta_5m', 'return_5m']);
});

test('rules: 价格上涨但 CVD 为负 → return_5m > 0 AND volume_delta_5m < 0', () => {
  const s = parseWithRules('XPL 5分钟价格上涨但 CVD 为负');
  assert.ok(!('error' in s));
  assert.ok(validateSpec(s.spec).ok);
  assert.deepEqual(s.spec.condition, {
    op: 'and',
    conditions: [
      { left: 'return_5m', operator: '>', right: { value: 0 } },
      { left: 'volume_delta_5m', operator: '<', right: { value: 0 } },
    ],
  });
});

test('extractJson strips think blocks and fences', () => {
  assert.deepEqual(extractJson('<think>{"no":1}</think>\n```json\n{"a":{"b":1}}\n```'), { a: { b: 1 } });
});

test('ssrf: private address detection', () => {
  for (const ip of ['127.0.0.1', '10.1.2.3', '172.20.0.1', '192.168.1.1', '169.254.169.254', '::1', 'fd00::1', '::ffff:127.0.0.1']) assert.ok(isPrivateAddress(ip), ip);
  for (const ip of ['8.8.8.8', '172.32.0.1', '2606:4700::1111']) assert.ok(!isPrivateAddress(ip), ip);
});

test('webhook: retries 5xx, stops on 4xx, signs body', async () => {
  const seen: { status: number; sig: string | undefined; body: string }[] = [];
  const plan = [503, 500, 200, 404];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const status = plan[seen.length] ?? 200;
      seen.push({ status, sig: req.headers['x-signalforge-signature'] as string, body });
      if (status === 200) {
        const expected = sign('s3cret', Number(req.headers['x-signalforge-timestamp']), body);
        assert.equal(req.headers['x-signalforge-signature'], expected);
      }
      res.writeHead(status).end();
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  const db = new Db(':memory:');
  const id = db.insertWebhook({ name: 't', url: `http://127.0.0.1:${port}/hook`, method: 'POST', headers: {}, secret: 's3cret', timeout_ms: 2000, max_retries: 3 });
  const d = new WebhookDispatcher(db, true, () => {}, [10, 10, 10]);
  const w = db.getWebhook(id)!;
  const r1 = await d.deliver(w, { hello: 1 }, null);
  assert.equal(r1.ok, true);
  assert.equal(r1.attempts, 3);
  const r2 = await d.deliver(w, { hello: 2 }, null);
  assert.equal(r2.ok, false);
  assert.equal(r2.attempts, 1); // 404 不重试
  assert.equal(db.listDeliveries({ webhookId: id }).length, 4);
  const blocked = await new WebhookDispatcher(db, false, () => {}, [10]).deliver(w, {}, null);
  assert.equal(blocked.ok, false);
  assert.match(blocked.error!, /private address/);
  server.close();
});

// ---------- 飞书机器人：专用格式 + 响应体判定（它出错也回 HTTP 200） ----------

test('feishu: url detection', () => {
  assert.ok(isFeishuWebhook('https://open.feishu.cn/open-apis/bot/v2/hook/abc'));
  assert.ok(isFeishuWebhook('https://open.larksuite.com/open-apis/bot/v2/hook/abc'));
  assert.ok(!isFeishuWebhook('https://open.feishu.cn/open-apis/im/v1/messages'));
  assert.ok(!isFeishuWebhook('https://evil.com/open.feishu.cn/open-apis/bot/v2/hook/abc'));
  assert.ok(!isFeishuWebhook('not a url'));
});

test('feishu: signature matches the official algorithm', () => {
  // 参考值由飞书文档的 Python 示例独立计算：base64(hmac(key=f"{ts}\n{secret}", msg=b""))
  assert.equal(feishuSign('demo', 1599360473), 'l1N0gAcBjdwBvGm1xMjOF0XSyaLRpR7tuO5dHfhAYc8=');
  const m = toFeishuMessage({ event: 'signal.test', symbol: 'BTCUSDT' }, {}, 'demo', 1599360473_500);
  assert.equal(m.timestamp, '1599360473');
  assert.equal(m.sign, 'l1N0gAcBjdwBvGm1xMjOF0XSyaLRpR7tuO5dHfhAYc8=');
  assert.equal('sign' in toFeishuMessage({}, {}, ''), false, '未配置 Secret 不带签名');
});

const T0 = Date.UTC(2026, 8, 30, 4, 5, 6); // 北京时间 12:05:06
const tick = { E: T0, last: 82563, high: 84381.3, low: 82563, change: -1000, changePct: -0.01286, volume: 16686.17, quoteVolume: 1.4e9 };
const extremeSpec = (dir: 'low' | 'high'): SignalSpec => ({
  name: `btc-24h-new-${dir}`, title: `BTC 24h New ${dir}`, description: '', cooldown_ms: 60_000,
  market: { exchange: 'binance', product: 'spot', symbol: 'BTCUSDT' },
  metrics: [
    { name: 'last_1s', kind: 'window', stream: 'aggTrade', window: '1s', filter: {}, field: 'price', aggregation: 'last' },
    { name: `${dir}_24h`, kind: 'ticker', stream: 'ticker', field: `${dir}_24h` },
  ],
  condition: { left: 'last_1s', operator: dir === 'low' ? '<' : '>', right: { metric: `${dir}_24h`, multiplier: 1 } },
});
const ev = (spec: SignalSpec) => ({ event: 'signal.triggered', event_id: 7, signal: spec.name, title: spec.title, symbol: 'BTCUSDT', timestamp: T0, condition: 'c', metrics: {} });

test('feishu: 24h new low → green card with the price that broke the old low', () => {
  const spec = extremeSpec('low');
  const m = toFeishuMessage(ev(spec), { spec, values: { last_1s: 82562.5, low_24h: 82563 }, ticker: tick }, '') as any;
  assert.equal(m.msg_type, 'interactive');
  assert.equal(m.card.header.title.content, '📉 BTC 24h 新低告警');
  assert.equal(m.card.header.template, 'green');
  const text = JSON.stringify(m.card.elements);
  for (const s of ['**新低价格**\\n**82,562.5**', '**跌破的 24h 低**\\n82,563', '📉 -1.286%', '**24h 高**\\n**84,381.3**', '2026/9/30 12:05:06 Beijing', '24h 成交量 16,686.17', 'event #7', 'SignalForge']) {
    assert.ok(text.includes(s), s);
  }
});

test('feishu: 24h new high → red card', () => {
  const spec = extremeSpec('high');
  const m = toFeishuMessage(ev(spec), { spec, values: { last_1s: 84400, high_24h: 84381.3 }, ticker: tick }, '') as any;
  assert.equal(m.card.header.title.content, '📈 BTC 24h 新高告警');
  assert.equal(m.card.header.template, 'red');
  assert.ok(JSON.stringify(m.card.elements).includes('**24h 低**'));
});

test('feishu: other signals (or an OR whose extreme leaf is false) use the generic card', () => {
  const spec = extremeSpec('low');
  spec.metrics.push({ name: 'pct', kind: 'ticker', stream: 'ticker', field: 'change_pct_24h' });
  spec.condition = { op: 'or', conditions: [spec.condition, { left: 'pct', operator: '<=', right: { value: -0.01 } }] };
  // 触发原因是跌幅分支，不是创新低：不能发"新低告警"
  const m = toFeishuMessage({ ...ev(spec), title: 'BTC Drop', metrics: { last_1s: 83000, low_24h: 82563, pct: -0.012 } }, { spec, values: { last_1s: 83000, low_24h: 82563, pct: -0.012 }, ticker: tick }, '') as any;
  assert.equal(m.card.header.title.content, '🔔 BTC Drop 触发');
  assert.equal(m.card.header.template, 'orange');
  assert.ok(JSON.stringify(m.card.elements).includes('**low_24h**\\n82,563'));
});

test('feishu: test message is a snapshot of the real ticker when available', () => {
  const snap = toFeishuMessage({ event: 'signal.test', symbol: 'BTCUSDT', timestamp: T0 }, { ticker: tick }, '') as any;
  assert.equal(snap.card.header.title.content, '📊 BTC 24h 状态快照');
  assert.equal(snap.card.header.template, 'blue');
  assert.ok(JSON.stringify(snap.card.elements).includes('**当前价格**\\n**82,563**'));
  const bare = toFeishuMessage({ event: 'signal.test', symbol: 'BTCUSDT' }, {}, '') as any;
  assert.equal(bare.card.header.title.content, '📊 SignalForge 测试消息');
});

test('feishu: response body decides success', () => {
  assert.equal(checkFeishuResponse('{"code":0,"data":{},"msg":"success"}'), null);
  assert.equal(checkFeishuResponse('{"Extra":null,"StatusCode":0,"StatusMessage":"success"}'), null);
  assert.deepEqual(checkFeishuResponse('{"code":19021,"msg":"sign match fail"}'), { error: 'feishu code 19021: sign match fail', retriable: false });
  assert.equal(checkFeishuResponse('{"code":11232,"msg":"frequency limited"}')!.retriable, true);
  assert.equal(checkFeishuResponse('<html>')!.retriable, false);
});

test('feishu: HTTP 200 with error code is logged as a failed delivery', async () => {
  const realFetch = globalThis.fetch;
  const sent: any[] = [];
  const replies = ['{"code":19002,"msg":"params error, msg_type need"}', '{"code":0,"msg":"success"}'];
  globalThis.fetch = (async (_url: string, init: RequestInit) => {
    sent.push({ headers: init.headers, body: JSON.parse(String(init.body)) });
    return new Response(replies[sent.length - 1], { status: 200 });
  }) as typeof fetch;
  try {
    const db = new Db(':memory:');
    const id = db.insertWebhook({ name: 'ai-lab', url: 'https://open.feishu.cn/open-apis/bot/v2/hook/xxxxx', method: 'POST', headers: {}, secret: 'demo', timeout_ms: 2000, max_retries: 3 });
    const d = new WebhookDispatcher(db, true, () => {}, [10, 10, 10]);
    const w = db.getWebhook(id)!;

    const bad = await d.deliver(w, { event: 'signal.test', symbol: 'BTCUSDT' }, null, true);
    assert.equal(bad.ok, false, '200 + code≠0 不能记为成功');
    assert.equal(bad.http_status, 200);
    assert.match(bad.error!, /feishu code 19002/);
    assert.equal(bad.attempts, 1, '业务错误不重试');

    const good = await d.deliver(w, { event: 'signal.test', symbol: 'BTCUSDT' }, null, true);
    assert.equal(good.ok, true);
    assert.equal(sent[1].body.msg_type, 'interactive');
    assert.ok(sent[1].body.sign, '请求体带飞书签名');
    assert.equal((sent[1].headers as Record<string, string>)['x-signalforge-signature'], undefined);
  } finally {
    globalThis.fetch = realFetch;
  }
});
