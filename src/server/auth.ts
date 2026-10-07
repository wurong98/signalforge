/**
 * 管理密码鉴权：未通过鉴权的请求一律拦截在 /api 之外。
 * - 密码不走环境变量：首次打开页面时设置，scrypt 哈希存入 ADMIN_FILE（默认 data/admin.json，权限 0600）
 * - 忘记密码：删除该文件即可，下次打开页面重新设置（无需重启，每次鉴权都会检查文件）
 * - 浏览器：登录换取 HttpOnly 会话 Cookie（EventSource 不能带自定义 header，只能靠 Cookie）
 * - 脚本 / curl：`Authorization: Bearer <管理密码>`
 * 会话令牌无状态：`<过期时间>.<HMAC(sessionKey, 过期时间)>`。sessionKey 随机生成并与哈希一起存放，
 * 因此重启不掉登录，而删除文件重设密码会让所有旧会话立即失效。
 * 静态资源（前端包）不拦截：它不含任何数据，页面加载后由前端自己显示设置 / 登录框。
 */
import { createHash, createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';

export const SESSION_COOKIE = 'sf_session';
export const MIN_PASSWORD_LENGTH = 8;
const SESSION_TTL_MS = 7 * 24 * 3600_000;
/** 登录失败限流：同一 IP 在窗口内失败次数达到上限后拒绝尝试，防暴力破解 */
const FAIL_WINDOW_MS = 15 * 60_000;
const FAIL_LIMIT = 10;
/** 无需鉴权即可访问的接口 */
const PUBLIC_PATHS = new Set(['/api/auth/status', '/api/auth/login', '/api/auth/setup']);

interface AdminFile {
  salt: string;
  hash: string;
  session_key: string;
}

function hashPassword(password: string, salt: Buffer): Buffer {
  return scryptSync(password, salt, 32);
}

function safeEqualHex(a: string, b: string): boolean {
  // 先各自哈希成定长再比较，避免长度差异导致 timingSafeEqual 抛错或泄露长度
  return timingSafeEqual(createHash('sha256').update(a).digest(), createHash('sha256').update(b).digest());
}

export class Auth {
  private cache: { stamp: string; data: AdminFile } | null = null;
  /** scrypt 较慢，Bearer 请求缓存最近一次校验通过的密码摘要；重设密码后 session_key 变化，缓存自然失效 */
  private bearerOk: string | null = null;
  private fails = new Map<string, { count: number; since: number }>();

  constructor(private file: string) {}

  /** 读取当前密码配置；文件不存在（未设置或已被删除）返回 null */
  private load(): AdminFile | null {
    let stamp: string;
    try {
      // inode + mtime：删除后重建的文件即使 mtime 相同也不会命中旧缓存
      const st = statSync(this.file);
      stamp = `${st.ino}:${st.mtimeMs}`;
    } catch {
      this.cache = null;
      return null;
    }
    if (this.cache?.stamp === stamp) return this.cache.data;
    const data = JSON.parse(readFileSync(this.file, 'utf8')) as AdminFile;
    this.cache = { stamp, data };
    return data;
  }

  configured(): boolean {
    return this.load() !== null;
  }

  /** 首次设置密码。已设置时返回 false；用 wx 标志写入，并发的两次设置只有一次成功 */
  setup(password: string): boolean {
    if (this.configured()) return false;
    const salt = randomBytes(16);
    const data: AdminFile = {
      salt: salt.toString('hex'),
      hash: hashPassword(password, salt).toString('hex'),
      session_key: randomBytes(32).toString('hex'),
    };
    mkdirSync(dirname(this.file), { recursive: true });
    try {
      writeFileSync(this.file, JSON.stringify(data), { flag: 'wx', mode: 0o600 });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'EEXIST') return false;
      throw e;
    }
    return true;
  }

  checkPassword(input: string): boolean {
    const d = this.load();
    if (!d) return false;
    return safeEqualHex(hashPassword(input, Buffer.from(d.salt, 'hex')).toString('hex'), d.hash);
  }

  issueToken(now = Date.now()): string | null {
    const d = this.load();
    if (!d) return null;
    const exp = String(now + SESSION_TTL_MS);
    return `${exp}.${createHmac('sha256', d.session_key).update(exp).digest('hex')}`;
  }

  verifyToken(token: string | undefined, now = Date.now()): boolean {
    const d = this.load();
    if (!d || !token) return false;
    const [exp, mac] = token.split('.');
    if (!exp || !mac || !/^\d+$/.test(exp) || Number(exp) <= now) return false;
    return safeEqualHex(mac, createHmac('sha256', d.session_key).update(exp).digest('hex'));
  }

  isAuthenticated(req: FastifyRequest): boolean {
    const h = req.headers.authorization;
    if (h?.startsWith('Bearer ')) {
      const d = this.load();
      if (!d) return false;
      const digest = createHmac('sha256', d.session_key).update(h.slice(7)).digest('hex');
      if (this.bearerOk === digest) return true;
      if (!this.checkPassword(h.slice(7))) return false;
      this.bearerOk = digest;
      return true;
    }
    return this.verifyToken(readCookie(req.headers.cookie, SESSION_COOKIE));
  }

  /** 返回 false 表示该 IP 已被限流 */
  allowAttempt(ip: string, now = Date.now()): boolean {
    const f = this.fails.get(ip);
    if (!f || now - f.since > FAIL_WINDOW_MS) return true;
    return f.count < FAIL_LIMIT;
  }

  recordFailure(ip: string, now = Date.now()) {
    const f = this.fails.get(ip);
    if (!f || now - f.since > FAIL_WINDOW_MS) this.fails.set(ip, { count: 1, since: now });
    else f.count++;
    // 防止 Map 被大量不同 IP 撑爆
    if (this.fails.size > 10_000) for (const [k, v] of this.fails) if (now - v.since > FAIL_WINDOW_MS) this.fails.delete(k);
  }

  clearFailures(ip: string) {
    this.fails.delete(ip);
  }
}

export function readCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) {
      try {
        return decodeURIComponent(part.slice(i + 1).trim());
      } catch {
        return undefined;
      }
    }
  }
  return undefined;
}

function sessionCookie(req: FastifyRequest, value: string, maxAgeSec: number) {
  // 经 HTTPS 反代访问时加 Secure；直接 HTTP 访问（本机/局域网）加了 Secure 浏览器就不会回传
  const https = req.protocol === 'https' || req.headers['x-forwarded-proto'] === 'https';
  return `${SESSION_COOKIE}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAgeSec}${https ? '; Secure' : ''}`;
}

const PasswordBody = z.object({ password: z.string().max(256) });

export function registerAuth(app: FastifyInstance, auth: Auth) {
  app.addHook('onRequest', async (req, reply: FastifyReply) => {
    // 按实际命中的路由判断，不看原始 URL：路由器会先解码再匹配，
    // `/%61pi/signals` 前缀不是 `/api/`，却会命中 `/api/signals`，按 URL 判断会被绕过
    const route = req.routeOptions.url ?? '';
    if (!route.startsWith('/api/') || PUBLIC_PATHS.has(route)) return;
    if (!auth.isAuthenticated(req)) return reply.code(401).send({ errors: ['需要输入管理密码'] });
  });

  app.get('/api/auth/status', async (req) => ({ configured: auth.configured(), authenticated: auth.isAuthenticated(req) }));

  const login = (req: FastifyRequest, reply: FastifyReply) => {
    const token = auth.issueToken();
    if (!token) return reply.code(409).send({ errors: ['尚未设置管理密码'] });
    reply.header('set-cookie', sessionCookie(req, token, SESSION_TTL_MS / 1000));
    return { ok: true };
  };

  app.post('/api/auth/setup', async (req, reply) => {
    const body = PasswordBody.safeParse(req.body);
    if (!body.success || body.data.password.length < MIN_PASSWORD_LENGTH)
      return reply.code(400).send({ errors: [`管理密码至少 ${MIN_PASSWORD_LENGTH} 位`] });
    if (!auth.setup(body.data.password)) return reply.code(409).send({ errors: ['管理密码已设置，请直接登录'] });
    return login(req, reply);
  });

  app.post('/api/auth/login', async (req, reply) => {
    const ip = req.ip;
    if (!auth.allowAttempt(ip)) return reply.code(429).send({ errors: ['尝试次数过多，请 15 分钟后再试'] });
    if (!auth.configured()) return reply.code(409).send({ errors: ['尚未设置管理密码'] });
    const body = PasswordBody.safeParse(req.body);
    if (!body.success || !auth.checkPassword(body.data.password)) {
      auth.recordFailure(ip);
      return reply.code(401).send({ errors: ['密码错误'] });
    }
    auth.clearFailures(ip);
    return login(req, reply);
  });

  app.post('/api/auth/logout', async (req, reply) => {
    reply.header('set-cookie', sessionCookie(req, '', 0));
    return { ok: true };
  });
}
