/**
 * Webhook 投递（PRD §10 §25）。
 * - 签名：X-SignalForge-Signature: sha256=HMAC_SHA256(secret, `${timestamp}.${body}`)
 * - 重试：网络错误 / 超时 / 5xx / 408 / 429 可重试，按 1s / 5s / 30s 退避；其余 4xx 不重试
 * - 安全：默认拒绝连接内网 / 回环 / 链路本地等地址，且不跟随重定向（防 SSRF）。
 *   地址校验放在建连时的 DNS lookup 钩子里，校验的就是实际要连接的那个 IP。
 *   若先 lookup 校验、再交给 fetch 自己解析，攻击者的域名可以第一次解析到公网、第二次解析到
 *   127.0.0.1 / 169.254.169.254（DNS rebinding），因此这里不用 fetch，改用 node:http(s)。
 * - 飞书机器人地址按飞书格式投递并校验响应体（见 feishu.ts）：它出错也回 HTTP 200
 */
import { createHmac } from 'node:crypto';
import { lookup as dnsLookup } from 'node:dns';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { BlockList, isIP, type LookupFunction } from 'node:net';
import { RETRY_DELAYS_MS } from '../../shared/dsl.ts';
import { isFeishuWebhook } from '../../shared/webhook.ts';
import type { Db, WebhookRow } from '../db.ts';
import type { FeishuContext, FeishuSource } from './feishu.ts';
import { checkFeishuResponse, toFeishuMessage } from './feishu.ts';

export interface AttemptResult {
  ok: boolean;
  http_status: number | null;
  latency_ms: number | null;
  error: string | null;
  retriable: boolean;
}

/** 响应体只为飞书校验而读，设上限防止被超大响应拖住内存 */
const MAX_RESPONSE_BYTES = 64 * 1024;

// BlockList 会把 IPv4 映射地址（::ffff:7f00:1 等各种写法）按 IPv4 规则匹配
const PRIVATE = new BlockList();
for (const [net, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
  ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['224.0.0.0', 3],
] as const) PRIVATE.addSubnet(net, prefix, 'ipv4');
for (const [net, prefix] of [
  ['::', 128], ['::1', 128], ['fc00::', 7], ['fe80::', 10], ['fec0::', 10], ['ff00::', 8],
  // NAT64 / 6to4 可把任意 IPv4（含内网）嵌进 IPv6，一并拒绝
  ['64:ff9b::', 96], ['64:ff9b:1::', 48], ['2002::', 16], ['100::', 64],
] as const) PRIVATE.addSubnet(net, prefix, 'ipv6');

export function isPrivateAddress(ip: string): boolean {
  const v = isIP(ip);
  if (!v) return true; // 不是合法 IP 一律视为不可投递
  return PRIVATE.check(ip, v === 4 ? 'ipv4' : 'ipv6');
}

class SsrfError extends Error {
  code = 'ESSRF';
  constructor(addr: string) {
    super(`webhook host resolves to private address ${addr} (set ALLOW_PRIVATE_WEBHOOKS=true for local testing)`);
  }
}

/** 建连时的 DNS 解析钩子：解析出的任一地址是内网即拒绝，否则把同一批地址交给 socket 连接 */
const guardedLookup: LookupFunction = (hostname, options, callback) => {
  dnsLookup(hostname, { ...options, all: true }, (err, addrs) => {
    if (err) return callback(err, '', 0);
    const bad = addrs.find((a) => isPrivateAddress(a.address));
    if (bad) return callback(new SsrfError(bad.address), '', 0);
    if (options.all) return (callback as any)(null, addrs);
    callback(null, addrs[0].address, addrs[0].family);
  });
};

/** 建连前就能判定的部分：协议，以及 URL 直接写 IP 的情况（IP 字面量不会走 lookup 钩子） */
export function assertDeliverable(url: string, allowPrivate: boolean): void {
  const u = new URL(url);
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('only http(s) URLs are allowed');
  if (allowPrivate) return;
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (isIP(host) && isPrivateAddress(host)) throw new SsrfError(host);
}

export function sign(secret: string, timestamp: number, body: string) {
  return `sha256=${createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex')}`;
}

export interface SendRequest {
  url: URL;
  method: string;
  headers: Record<string, string>;
  body: string;
  timeoutMs: number;
  allowPrivate: boolean;
  /** 按状态码决定是否读取响应体；不读时直接丢弃 */
  readBody: (status: number) => boolean;
}
/** 传输层可替换，仅供测试注入 */
export type Transport = (r: SendRequest) => Promise<{ status: number; text: string | null }>;

/** 发一次请求，不跟随重定向（node:http 本身就不跟随） */
export const send: Transport = ({ url, method, headers, body, timeoutMs, allowPrivate, readBody }) => {
  return new Promise((resolve, reject) => {
    const req = (url.protocol === 'https:' ? httpsRequest : httpRequest)(
      url,
      {
        method,
        headers: { ...headers, 'content-length': String(Buffer.byteLength(body)) },
        signal: AbortSignal.timeout(timeoutMs),
        lookup: allowPrivate ? undefined : guardedLookup,
      },
      (res) => {
        const status = res.statusCode ?? 0;
        if (!readBody(status)) {
          res.resume();
          res.on('end', () => resolve({ status, text: null }));
          res.on('error', reject);
          return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        res.on('data', (c: Buffer) => {
          size += c.length;
          if (size > MAX_RESPONSE_BYTES) return res.destroy(new Error(`response body exceeds ${MAX_RESPONSE_BYTES} bytes`));
          chunks.push(c);
        });
        res.on('end', () => resolve({ status, text: Buffer.concat(chunks).toString('utf8') }));
        res.on('error', reject);
      },
    );
    req.on('error', reject);
    req.end(body);
  });
};

export async function attempt(w: WebhookRow, body: string, allowPrivate: boolean, transport: Transport = send): Promise<AttemptResult> {
  const started = performance.now();
  try {
    assertDeliverable(w.url, allowPrivate);
  } catch (e) {
    return { ok: false, http_status: null, latency_ms: null, error: (e as Error).message, retriable: false };
  }
  const ts = Date.now();
  const feishu = isFeishuWebhook(w.url);
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'user-agent': 'SignalForge-Webhook/1.0',
    'x-signalforge-timestamp': String(ts),
    ...w.headers,
  };
  // 飞书的 Secret 是它自己的签名校验密钥，签名已在请求体里，不再附加 SignalForge 签名头
  if (w.secret && !feishu) headers['x-signalforge-signature'] = sign(w.secret, ts, body);
  try {
    const isOk = (status: number) => status >= 200 && status < 300;
    const res = await transport({ url: new URL(w.url), method: w.method, headers, body, timeoutMs: w.timeout_ms, allowPrivate, readBody: (st) => feishu && isOk(st) });
    const latency = Math.round(performance.now() - started);
    if (feishu && isOk(res.status)) {
      const bad = checkFeishuResponse(res.text ?? '');
      return { ok: !bad, http_status: res.status, latency_ms: latency, error: bad?.error ?? null, retriable: bad?.retriable ?? false };
    }
    const ok = isOk(res.status);
    return {
      ok,
      http_status: res.status,
      latency_ms: latency,
      error: ok ? null : `HTTP ${res.status}${res.status >= 300 && res.status < 400 ? ' (redirects are not followed)' : ''}`,
      retriable: res.status >= 500 || res.status === 408 || res.status === 429,
    };
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    const latency = Math.round(performance.now() - started);
    // DNS rebinding 被建连钩子拦下：配置性错误，重试没有意义
    if (err.code === 'ESSRF') return { ok: false, http_status: null, latency_ms: latency, error: err.message, retriable: false };
    const timeout = err.name === 'TimeoutError' || err.name === 'AbortError';
    return {
      ok: false,
      http_status: null,
      latency_ms: latency,
      error: timeout ? `timeout after ${w.timeout_ms}ms` : `${err.message}${err.code && !err.message.includes(err.code) ? ` (${err.code})` : ''}`,
      retriable: true,
    };
  }
}

export class WebhookDispatcher {
  constructor(
    private db: Db,
    private allowPrivate: boolean,
    private onChange: () => void = () => {},
    private delays: number[] = RETRY_DELAYS_MS,
    private transport: Transport = send,
  ) {}

  /** 投递并按策略重试，每次尝试都写入日志；返回最终是否成功 */
  /** feishu：通用 payload 之外、仅供飞书卡片使用的上下文（spec / 触发值 / ticker），不影响其他 Webhook 的报文 */
  async deliver(
    w: WebhookRow,
    payload: unknown,
    eventId: number | null,
    isTest = false,
    feishu: FeishuContext = {},
  ): Promise<AttemptResult & { attempts: number }> {
    // 飞书签名的时间戳须在 1 小时内，整轮重试最长约 36s，生成一次即可
    const body = JSON.stringify(isFeishuWebhook(w.url) ? toFeishuMessage(payload as FeishuSource, feishu, w.secret) : payload);
    const maxAttempts = 1 + Math.min(w.max_retries, this.delays.length);
    let last!: AttemptResult;
    for (let n = 1; n <= maxAttempts; n++) {
      if (n > 1) await new Promise((r) => setTimeout(r, this.delays[n - 2]));
      last = await attempt(w, body, this.allowPrivate, this.transport);
      this.db.insertDelivery({
        event_id: eventId, webhook_id: w.id, attempt: n, ts: Date.now(), ok: last.ok,
        http_status: last.http_status, latency_ms: last.latency_ms, error: last.error, is_test: isTest,
      });
      this.onChange();
      if (last.ok || !last.retriable) return { ...last, attempts: n };
    }
    return { ...last, attempts: maxAttempts };
  }
}
