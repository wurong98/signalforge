/**
 * 飞书自定义机器人适配（PRD §10 Webhook 的目标适配）。
 * 通用 Webhook 投递的是 SignalForge 自己的事件 JSON；飞书机器人只认自己的消息格式，
 * 且无论成败都返回 HTTP 200，只看状态码会把"被飞书拒收"误记为投递成功。因此：
 * - 请求体：事件 → 飞书消息卡片（interactive）；
 * - 签名：Webhook 的 Secret 即飞书"签名校验"密钥，按飞书算法放进请求体（timestamp + sign）；
 * - 响应：解析响应体，code ≠ 0 视为失败，并把飞书的错误信息写进投递日志。
 */
import { createHmac } from 'node:crypto';

/** 事件 / 测试 payload 中飞书卡片用得到的字段（其余字段忽略） */
export interface FeishuSource {
  event?: string;
  event_id?: number;
  signal?: string;
  title?: string;
  symbol?: string;
  exchange?: string;
  market?: string;
  timestamp?: number;
  condition?: string;
  metrics?: Record<string, number | null>;
}

/** 飞书签名：base64(HMAC-SHA256(key = `${timestamp}\n${secret}`, message = "")) ，timestamp 为秒 */
export function feishuSign(secret: string, timestampSec: number): string {
  return createHmac('sha256', `${timestampSec}\n${secret}`).update('').digest('base64');
}

const fmtNum = (v: number | null) => {
  if (v == null) return '—';
  if (Number.isInteger(v)) return v.toLocaleString('en-US');
  return Math.abs(v) >= 1 ? v.toLocaleString('en-US', { maximumFractionDigits: 4 }) : String(Number(v.toPrecision(6)));
};

// 服务端时区不可控，统一按北京时间展示并注明，避免飞书里看到的时间含糊
const fmtTime = (ms: number) =>
  `${new Date(ms).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })} (UTC+8)`;

export function toFeishuMessage(p: FeishuSource, secret: string, nowMs = Date.now()): Record<string, unknown> {
  const isTest = p.event === 'signal.test';
  const title = isTest ? 'SignalForge 测试消息' : `SignalForge · ${p.title ?? p.signal ?? 'Signal'} 触发`;
  const lines = [
    `**交易对**：${p.symbol ?? '—'}${p.exchange ? ` · ${[p.exchange, p.market].filter(Boolean).join(' ')}` : ''}`,
    p.signal && !isTest ? `**Signal**：${p.signal}` : null,
    p.condition ? `**条件**：${p.condition}` : null,
    p.timestamp != null ? `**时间**：${fmtTime(p.timestamp)}` : null,
  ].filter((x): x is string => x !== null);
  const metrics = Object.entries(p.metrics ?? {}).map(([k, v]) => `- ${k} = ${fmtNum(v)}`);

  const elements: unknown[] = [{ tag: 'div', text: { tag: 'lark_md', content: lines.join('\n') } }];
  if (metrics.length) {
    elements.push({ tag: 'hr' }, { tag: 'div', text: { tag: 'lark_md', content: `**触发时指标**\n${metrics.join('\n')}` } });
  }
  if (p.event_id != null) elements.push({ tag: 'note', elements: [{ tag: 'plain_text', content: `event #${p.event_id}` }] });

  const msg: Record<string, unknown> = {
    msg_type: 'interactive',
    card: {
      config: { wide_screen_mode: true },
      header: { template: isTest ? 'blue' : 'orange', title: { tag: 'plain_text', content: title } },
      elements,
    },
  };
  if (secret) {
    const ts = Math.floor(nowMs / 1000);
    msg.timestamp = String(ts);
    msg.sign = feishuSign(secret, ts);
  }
  return msg;
}

/** 飞书限流错误码：可重试；其余业务错误（签名、关键词、格式）重试也不会成功 */
const RETRIABLE_CODES = new Set([9499, 11232]);

/**
 * 解析飞书响应体。新版返回 {code, msg}，旧版返回 {StatusCode, StatusMessage}。
 * 返回 null 表示成功。
 */
export function checkFeishuResponse(text: string): { error: string; retriable: boolean } | null {
  let j: any;
  try {
    j = JSON.parse(text);
  } catch {
    return { error: `feishu: 无法解析响应 ${text.slice(0, 200)}`, retriable: false };
  }
  const code = j?.code ?? j?.StatusCode;
  if (code === 0) return null;
  const msg = j?.msg ?? j?.StatusMessage ?? '';
  return { error: `feishu code ${code}: ${msg}`, retriable: RETRIABLE_CODES.has(Number(code)) };
}
