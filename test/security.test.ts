import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import { MASK, maskWebhook, unmaskWebhookInput } from '../src/server/api.ts';
import type { WebhookRow } from '../src/server/db.ts';
import { RateLimiter } from '../src/server/ratelimit.ts';
import { attempt, isPrivateAddress } from '../src/server/webhook/delivery.ts';

const hook = (over: Partial<WebhookRow> = {}): WebhookRow => ({
  id: 1, created_at: 0, name: 'h', url: 'http://localhost:1/x', method: 'POST',
  headers: { authorization: 'Bearer sk-live-123' }, secret: 's3cret', timeout_ms: 2000, max_retries: 0, ...over,
});

test('ssrf: 私有地址判定覆盖 IPv4 映射 / NAT64 / 6to4 等写法', () => {
  for (const ip of [
    '0.0.0.0', '100.64.0.1', '198.18.0.1', '240.0.0.1',
    '::ffff:7f00:1', '0:0:0:0:0:ffff:7f00:0001', '::ffff:169.254.169.254',
    '64:ff9b::a00:1', '2002:7f00:1::', 'fec0::1', 'ff02::1', 'FD00::1', 'not-an-ip',
  ]) assert.ok(isPrivateAddress(ip), ip);
  for (const ip of ['8.8.8.8', '1.1.1.1', '::ffff:8.8.8.8', '2606:4700::1111']) assert.ok(!isPrivateAddress(ip), ip);
});

test('ssrf: 域名在建连时解析到内网即拒绝（DNS rebinding 防线），且不重试、不发出请求', async () => {
  let hits = 0;
  const srv = createServer((_, res) => (hits++, res.end('ok'))).listen(0, '127.0.0.1');
  await new Promise((r) => srv.once('listening', r));
  const port = (srv.address() as AddressInfo).port;
  try {
    // 域名（走 lookup 钩子）
    const byName = await attempt(hook({ url: `http://localhost:${port}/x` }), '{}', false);
    assert.equal(byName.ok, false);
    assert.equal(byName.retriable, false);
    assert.match(byName.error!, /private address/);
    // IP 字面量（不走 lookup，靠建连前检查）
    for (const url of [`http://127.0.0.1:${port}/x`, `http://[::ffff:127.0.0.1]:${port}/x`]) {
      const r = await attempt(hook({ url }), '{}', false);
      assert.equal(r.ok, false, url);
      assert.equal(r.retriable, false, url);
    }
    assert.equal(hits, 0);
    // 显式允许时可以投递，签名头照常带上
    const ok = await attempt(hook({ url: `http://localhost:${port}/x` }), '{}', true);
    assert.equal(ok.ok, true);
    assert.equal(hits, 1);
  } finally {
    srv.close();
  }
});

test('ssrf: 不跟随重定向', async () => {
  let followed = false;
  const srv = createServer((req, res) => {
    if (req.url === '/next') followed = true;
    res.writeHead(302, { location: '/next' }).end();
  }).listen(0, '127.0.0.1');
  await new Promise((r) => srv.once('listening', r));
  try {
    const r = await attempt(hook({ url: `http://127.0.0.1:${(srv.address() as AddressInfo).port}/` }), '{}', true);
    assert.equal(r.ok, false);
    assert.equal(r.http_status, 302);
    assert.match(r.error!, /redirects are not followed/);
    assert.equal(followed, false);
  } finally {
    srv.close();
  }
});

test('webhook: 超时', async () => {
  const srv = createServer(() => {}).listen(0, '127.0.0.1');
  await new Promise((r) => srv.once('listening', r));
  try {
    const r = await attempt(hook({ url: `http://127.0.0.1:${(srv.address() as AddressInfo).port}/`, timeout_ms: 200 }), '{}', true);
    assert.equal(r.ok, false);
    assert.equal(r.retriable, true);
    assert.match(r.error!, /timeout after 200ms/);
  } finally {
    srv.closeAllConnections();
    srv.close();
  }
});

test('secret: 返回值打码，secret 与 header 值都不外泄', () => {
  const m = maskWebhook(hook());
  assert.equal(m.secret, MASK);
  assert.deepEqual(m.headers, { authorization: MASK });
  assert.ok(!JSON.stringify(m).includes('s3cret'));
  assert.ok(!JSON.stringify(m).includes('sk-live-123'));
  assert.equal(maskWebhook(hook({ secret: '' })).secret, '');
});

test('secret: 回传掩码保留原值，改名但值仍是掩码则报错', () => {
  const cur = hook();
  const kept = unmaskWebhookInput({ ...maskWebhook(cur), name: 'renamed' }, cur);
  assert.ok('input' in kept);
  assert.equal(kept.input.secret, 's3cret');
  assert.deepEqual(kept.input.headers, { authorization: 'Bearer sk-live-123' });
  const changed = unmaskWebhookInput({ secret: 'new', headers: { authorization: 'Bearer new', 'x-extra': '1' } }, cur);
  assert.ok('input' in changed);
  assert.equal(changed.input.secret, 'new');
  assert.deepEqual(changed.input.headers, { authorization: 'Bearer new', 'x-extra': '1' });
  const renamed = unmaskWebhookInput({ headers: { 'x-api-key': MASK } }, cur);
  assert.ok('error' in renamed);
});

test('ratelimit: 窗口内超限拒绝，窗口过后恢复，按 key 隔离', () => {
  const rl = new RateLimiter(2, 60_000);
  assert.equal(rl.take('a', 0), 0);
  assert.equal(rl.take('a', 1), 0);
  assert.equal(rl.take('a', 1000), 59);
  assert.equal(rl.take('b', 1000), 0);
  assert.equal(rl.take('a', 60_000), 0);
});
