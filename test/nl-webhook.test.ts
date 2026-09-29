import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import { Db } from '../src/server/db.ts';
import { extractJson, parseNaturalLanguage } from '../src/server/nl/parse.ts';
import { parseWithRules } from '../src/server/nl/rules.ts';
import { WebhookDispatcher, isPrivateAddress, sign } from '../src/server/webhook/delivery.ts';

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
