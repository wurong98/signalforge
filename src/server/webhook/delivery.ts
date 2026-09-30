/**
 * Webhook 投递（PRD §10 §25）。
 * - 签名：X-SignalForge-Signature: sha256=HMAC_SHA256(secret, `${timestamp}.${body}`)
 * - 重试：网络错误 / 超时 / 5xx / 408 / 429 可重试，按 1s / 5s / 30s 退避；其余 4xx 不重试
 * - 安全：默认拒绝解析到内网 / 回环 / 链路本地地址的 URL，且不跟随重定向（防 SSRF）
 * - 飞书机器人地址按飞书格式投递并校验响应体（见 feishu.ts）：它出错也回 HTTP 200
 */
import { createHmac } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
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

export function isPrivateAddress(ip: string): boolean {
  if (isIP(ip) === 4) {
    const [a, b] = ip.split('.').map(Number);
    return (
      a === 10 || a === 127 || a === 0 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127) ||
      a >= 224
    );
  }
  const x = ip.toLowerCase();
  if (x.startsWith('::ffff:')) return isPrivateAddress(x.slice(7));
  return x === '::1' || x === '::' || x.startsWith('fc') || x.startsWith('fd') || x.startsWith('fe80');
}

export async function assertDeliverable(url: string, allowPrivate: boolean): Promise<void> {
  const u = new URL(url);
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('only http(s) URLs are allowed');
  if (allowPrivate) return;
  const host = u.hostname.replace(/^\[|\]$/g, '');
  const addrs = isIP(host) ? [host] : (await lookup(host, { all: true })).map((a) => a.address);
  const bad = addrs.find(isPrivateAddress);
  if (bad) throw new Error(`webhook host resolves to private address ${bad} (set ALLOW_PRIVATE_WEBHOOKS=true for local testing)`);
}

export function sign(secret: string, timestamp: number, body: string) {
  return `sha256=${createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex')}`;
}

export async function attempt(w: WebhookRow, body: string, allowPrivate: boolean): Promise<AttemptResult> {
  const started = performance.now();
  try {
    await assertDeliverable(w.url, allowPrivate);
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
    const res = await fetch(w.url, {
      method: w.method,
      headers,
      body,
      redirect: 'manual',
      signal: AbortSignal.timeout(w.timeout_ms),
    });
    const latency = Math.round(performance.now() - started);
    const httpOk = res.status >= 200 && res.status < 300;
    if (feishu && httpOk) {
      const bad = checkFeishuResponse(await res.text());
      return { ok: !bad, http_status: res.status, latency_ms: latency, error: bad?.error ?? null, retriable: bad?.retriable ?? false };
    }
    await res.body?.cancel().catch(() => {});
    const ok = httpOk;
    return {
      ok,
      http_status: res.status,
      latency_ms: latency,
      error: ok ? null : `HTTP ${res.status}${res.status >= 300 && res.status < 400 ? ' (redirects are not followed)' : ''}`,
      retriable: res.status >= 500 || res.status === 408 || res.status === 429,
    };
  } catch (e) {
    const err = e as Error;
    const timeout = err.name === 'TimeoutError' || err.name === 'AbortError';
    return {
      ok: false,
      http_status: null,
      latency_ms: Math.round(performance.now() - started),
      error: timeout ? `timeout after ${w.timeout_ms}ms` : `${err.message}${(err as any).cause ? `: ${(err as any).cause.message ?? (err as any).cause.code}` : ''}`,
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
      last = await attempt(w, body, this.allowPrivate);
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
