import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import Fastify from 'fastify';
import { Auth, SESSION_COOKIE, readCookie, registerAuth } from '../src/server/auth.ts';

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'sf-auth-'));
  const file = join(dir, 'admin.json');
  const auth = new Auth(file);
  const app = Fastify();
  registerAuth(app, auth);
  app.get('/api/signals', async () => ({ ok: true }));
  app.get('/api/live', async () => ({ ok: true }));
  app.get('/index.html', async () => 'page');
  return { app, auth, file, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

const cookieOf = (res: { headers: Record<string, any> }) => {
  const v = readCookie(String(res.headers['set-cookie']).split(';')[0], SESSION_COOKIE);
  return `${SESSION_COOKIE}=${v}`;
};

test('auth: 未设置密码时同样拦截所有 /api，静态资源放行', async () => {
  const { app, cleanup } = setup();
  try {
    assert.equal((await app.inject('/api/signals')).statusCode, 401);
    assert.equal((await app.inject('/api/live')).statusCode, 401);
    assert.equal((await app.inject('/api/signals?x=1')).statusCode, 401);
    // 编码过的路径会被路由器解码后命中 /api 路由，必须同样拦截
    assert.equal((await app.inject('/%61pi/signals')).statusCode, 401);
    assert.equal((await app.inject('/api%2Fsignals')).statusCode, 404);
    assert.equal((await app.inject('/index.html')).statusCode, 200);
    assert.deepEqual((await app.inject('/api/auth/status')).json(), { configured: false, authenticated: false });
    // 未设置时不能登录
    assert.equal((await app.inject({ method: 'POST', url: '/api/auth/login', payload: { password: 'whatever1' } })).statusCode, 409);
  } finally {
    cleanup();
  }
});

test('auth: 首次设置 → 带会话 Cookie 访问；不能重复设置', async () => {
  const { app, file, cleanup } = setup();
  try {
    assert.equal((await app.inject({ method: 'POST', url: '/api/auth/setup', payload: { password: 'short' } })).statusCode, 400);
    const res = await app.inject({ method: 'POST', url: '/api/auth/setup', payload: { password: 'correct horse' } });
    assert.equal(res.statusCode, 200);
    assert.match(String(res.headers['set-cookie']), /HttpOnly; SameSite=Strict/);
    assert.equal(statSync(file).mode & 0o777, 0o600);
    const cookie = cookieOf(res);
    assert.equal((await app.inject({ url: '/api/signals', headers: { cookie } })).statusCode, 200);
    assert.deepEqual((await app.inject({ url: '/api/auth/status', headers: { cookie } })).json(), { configured: true, authenticated: true });
    // 已设置后，setup 不能被用来覆盖密码
    assert.equal((await app.inject({ method: 'POST', url: '/api/auth/setup', payload: { password: 'attacker pw' } })).statusCode, 409);
  } finally {
    cleanup();
  }
});

test('auth: 登录、错误密码、伪造 Cookie、Bearer', async () => {
  const { app, auth, cleanup } = setup();
  try {
    auth.setup('correct horse');
    assert.equal((await app.inject({ method: 'POST', url: '/api/auth/login', payload: { password: 'wrong' } })).statusCode, 401);
    const ok = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { password: 'correct horse' } });
    assert.equal(ok.statusCode, 200);
    assert.equal((await app.inject({ url: '/api/signals', headers: { cookie: cookieOf(ok) } })).statusCode, 200);
    // 伪造 / 过期令牌
    assert.equal((await app.inject({ url: '/api/signals', headers: { cookie: `${SESSION_COOKIE}=99999999999999.deadbeef` } })).statusCode, 401);
    const expired = auth.issueToken(Date.now() - 8 * 24 * 3600_000)!;
    assert.equal(auth.verifyToken(expired), false);
    // Bearer
    assert.equal((await app.inject({ url: '/api/signals', headers: { authorization: 'Bearer correct horse' } })).statusCode, 200);
    assert.equal((await app.inject({ url: '/api/signals', headers: { authorization: 'Bearer correct horse' } })).statusCode, 200);
    assert.equal((await app.inject({ url: '/api/signals', headers: { authorization: 'Bearer nope' } })).statusCode, 401);
  } finally {
    cleanup();
  }
});

test('auth: 删除密码文件 → 旧会话失效，可重新设置', async () => {
  const { app, auth, file, cleanup } = setup();
  try {
    auth.setup('first password');
    const old = (await app.inject({ method: 'POST', url: '/api/auth/login', payload: { password: 'first password' } }));
    const oldCookie = cookieOf(old);
    assert.equal((await app.inject({ url: '/api/signals', headers: { authorization: 'Bearer first password' } })).statusCode, 200);
    rmSync(file);
    assert.equal((await app.inject({ url: '/api/signals', headers: { cookie: oldCookie } })).statusCode, 401);
    assert.equal((await app.inject({ url: '/api/auth/status' })).json().configured, false);
    const res = await app.inject({ method: 'POST', url: '/api/auth/setup', payload: { password: 'second password' } });
    assert.equal(res.statusCode, 200);
    // 旧 Cookie、旧密码（含 Bearer 缓存）都不能再用
    assert.equal((await app.inject({ url: '/api/signals', headers: { cookie: oldCookie } })).statusCode, 401);
    assert.equal((await app.inject({ url: '/api/signals', headers: { authorization: 'Bearer first password' } })).statusCode, 401);
    assert.equal((await app.inject({ url: '/api/signals', headers: { cookie: cookieOf(res) } })).statusCode, 200);
  } finally {
    cleanup();
  }
});

test('auth: 登录失败限流', async () => {
  const { app, auth, cleanup } = setup();
  try {
    auth.setup('correct horse');
    for (let i = 0; i < 10; i++)
      assert.equal((await app.inject({ method: 'POST', url: '/api/auth/login', payload: { password: 'wrong' } })).statusCode, 401);
    // 达到上限后即使密码正确也拒绝
    assert.equal((await app.inject({ method: 'POST', url: '/api/auth/login', payload: { password: 'correct horse' } })).statusCode, 429);
  } finally {
    cleanup();
  }
});
