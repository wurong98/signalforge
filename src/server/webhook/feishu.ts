/**
 * 飞书自定义机器人适配（PRD §10 Webhook 的目标适配）。
 * 通用 Webhook 投递的是 SignalForge 自己的事件 JSON；飞书机器人只认自己的消息格式，
 * 且无论成败都返回 HTTP 200，只看状态码会把"被飞书拒收"误记为投递成功。因此：
 * - 请求体：事件 → 飞书消息卡片（interactive）；
 * - 签名：Webhook 的 Secret 即飞书"签名校验"密钥，按飞书算法放进请求体（timestamp + sign）；
 * - 响应：解析响应体，code ≠ 0 视为失败，并把飞书的错误信息写进投递日志。
 *
 * 卡片版式沿用已在群里实测可用的 bnb_extremes.py：两列 is_short 字段、新低绿 / 新高红、
 * 脚注写北京时间与 24h 成交量。卡片类型由 DSL 决定，不靠猜指标名：
 * - 24h 新低 / 新高：某个叶子条件是 `X < ticker.low_24h`（或 `X > ticker.high_24h`）且此刻成立；
 * - 其他 Signal：通用卡片，列出条件与触发时指标；
 * - 测试：有 ticker 快照时发真实行情的状态快照卡，否则发连通性测试卡。
 */
import { createHmac } from 'node:crypto';
import type { Condition, LeafCondition, SignalSpec } from '../../shared/dsl.ts';
import { isLeaf } from '../../shared/dsl.ts';
import type { MetricValue, Ticker } from '../engine/window.ts';

/** 事件 / 测试 payload 中飞书卡片用得到的字段（其余字段忽略） */
export interface FeishuSource {
  event?: string;
  event_id?: number;
  signal?: string;
  title?: string;
  /** spot / futures（U 本位永续）；同名交易对两个市场行情不同，卡片上要标出来 */
  market?: string;
  symbol?: string;
  timestamp?: number;
  condition?: string;
  metrics?: Record<string, number | null>;
}

/** 通用 payload 里没有、但飞书卡片需要的上下文：用于判断卡片类型与补全 24h 行情 */
export interface FeishuContext {
  spec?: SignalSpec;
  /** 触发时的指标值（即事件快照） */
  values?: Record<string, MetricValue>;
  /** 触发时的 24h ticker 快照 */
  ticker?: Ticker | null;
}

/** 飞书签名：base64(HMAC-SHA256(key = `${timestamp}\n${secret}`, message = "")) ，timestamp 为秒 */
export function feishuSign(secret: string, timestampSec: number): string {
  return createHmac('sha256', `${timestampSec}\n${secret}`).update('').digest('base64');
}

export const fmtNum = (v: number | null | undefined) => {
  if (v == null) return '—';
  if (Number.isInteger(v)) return v.toLocaleString('en-US');
  return Math.abs(v) >= 1 ? v.toLocaleString('en-US', { maximumFractionDigits: 4 }) : String(Number(v.toPrecision(6)));
};

/** 小数涨跌幅 → "+2.736%" */
const fmtPct = (f: number) => `${f >= 0 ? '+' : ''}${(f * 100).toFixed(3)}%`;
/** 箭头跟涨跌幅符号走，而不是跟告警方向：创新低时 24h 仍可能是涨的 */
const fmtChange = (f: number) => `${f >= 0 ? '📈' : '📉'} ${fmtPct(f)}`;

// 服务端时区不可控，统一按北京时间展示并注明
const fmtTime = (ms: number) => new Date(ms).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });

const symbolOf = (p: FeishuSource) => (p.symbol ? `${p.symbol}${p.market === 'futures' ? ' 永续' : ''}` : '—');
const baseOf = (symbol: string) => symbol.replace(/(USDT|USDC|FDUSD|BTC)$/, '') || symbol;
const titleOf = (p: FeishuSource) => `${baseOf(p.symbol ?? '—')}${p.market === 'futures' ? ' 永续' : ''}`;

const field = (label: string, value: string) => ({ is_short: true, text: { tag: 'lark_md', content: `**${label}**\n${value}` } });
const md = (content: string) => ({ tag: 'div', text: { tag: 'lark_md', content } });
const note = (content: string) => ({ tag: 'note', elements: [{ tag: 'plain_text', content }] });
const HR = { tag: 'hr' };

const card = (title: string, template: string, elements: unknown[]) => ({
  msg_type: 'interactive',
  card: { config: { wide_screen_mode: true }, header: { template, title: { tag: 'plain_text', content: title } }, elements },
});

function leaves(c: Condition): LeafCondition[] {
  return isLeaf(c) ? [c] : c.conditions.flatMap(leaves);
}

export interface ExtremeHit {
  direction: 'low' | 'high';
  /** 突破时的成交价（条件左值） */
  price: number;
  /** 被突破的 24h 极值（ticker 尚未刷新的旧值） */
  broken: number;
}

/** 从 DSL 判断这次触发是否是"24h 新低 / 新高"，以及突破价与被突破的极值 */
export function detectExtreme(spec: SignalSpec, values: Record<string, MetricValue>): ExtremeHit | null {
  for (const c of leaves(spec.condition)) {
    if (!('metric' in c.right)) continue;
    const ref = c.right.metric;
    const m = spec.metrics.find((x) => x.name === ref);
    if (m?.kind !== 'ticker') continue;
    const direction =
      m.field === 'low_24h' && (c.operator === '<' || c.operator === '<=') ? 'low'
      : m.field === 'high_24h' && (c.operator === '>' || c.operator === '>=') ? 'high'
      : null;
    const price = values[c.left];
    const base = values[ref];
    if (!direction || price == null || base == null) continue;
    const broken = base * c.right.multiplier;
    const strict = c.operator === '<' || c.operator === '>';
    const passed = direction === 'low' ? (strict ? price < broken : price <= broken) : strict ? price > broken : price >= broken;
    // OR 条件里可能还有别的分支；只有这个叶子此刻成立，才说明触发原因是创新低/新高
    if (passed) return { direction, price, broken };
  }
  return null;
}

function footer(p: FeishuSource, ticker: Ticker | null | undefined, ms: number) {
  const parts = [`⏰ ${p.event === 'signal.test' ? '' : '触发于 '}${fmtTime(ms)} Beijing`];
  if (ticker) parts.push(`24h 成交量 ${fmtNum(ticker.volume)}`);
  if (p.event_id != null) parts.push(`event #${p.event_id}`);
  parts.push('SignalForge'); // 飞书"自定义关键词"可设为 SignalForge，每张卡片都带
  return note(parts.join(' · '));
}

function extremeCard(p: FeishuSource, hit: ExtremeHit, t: Ticker | null | undefined, ms: number) {
  const low = hit.direction === 'low';
  const symbol = symbolOf(p);
  const fields = [
    field('交易对', `**${symbol}**`),
    field(low ? '新低价格' : '新高价格', `**${fmtNum(hit.price)}**`),
    field(low ? '跌破的 24h 低' : '突破的 24h 高', fmtNum(hit.broken)),
  ];
  if (t) {
    fields.push(
      field('24h 变化', fmtChange(t.changePct)),
      low ? field('24h 高', `**${fmtNum(t.high)}**`) : field('24h 低', `**${fmtNum(t.low)}**`),
    );
  }
  return card(`${low ? '📉' : '📈'} ${titleOf(p)} 24h ${low ? '新低' : '新高'}告警`, low ? 'green' : 'red', [
    md(low ? '**帅哥，快来抄底呀~** 🚀' : '**嘿，破新高了~** ⚡'),
    HR,
    { tag: 'div', fields },
    HR,
    footer(p, t, ms),
  ]);
}

function genericCard(p: FeishuSource, t: Ticker | null | undefined, ms: number) {
  const metrics = Object.entries(p.metrics ?? {}).map(([k, v]) => field(k, fmtNum(v)));
  return card(`🔔 ${p.title ?? p.signal ?? 'Signal'} 触发`, 'orange', [
    { tag: 'div', fields: [field('交易对', `**${symbolOf(p)}**`), field('Signal', p.signal ?? '—')] },
    ...(p.condition ? [md(`**条件**\n${p.condition}`)] : []),
    ...(metrics.length ? [HR, md('**触发时指标**'), { tag: 'div', fields: metrics }] : []),
    HR,
    footer(p, t, ms),
  ]);
}

/** 测试：有真实 ticker 就发状态快照（与 bnb_extremes.py --test-feishu 一致，不用假数据） */
function testCard(p: FeishuSource, t: Ticker | null | undefined, ms: number) {
  const symbol = symbolOf(p);
  if (!t) {
    return card('📊 SignalForge 测试消息', 'blue', [md('**连通性测试**：频道可正常接收 SignalForge 卡片（暂无行情快照）'), HR, footer(p, null, ms)]);
  }
  return card(`📊 ${titleOf(p)} 24h 状态快照`, 'blue', [
    md('**SignalForge 测试消息**：频道连通，以下为当前真实行情（非告警）'),
    HR,
    {
      tag: 'div',
      fields: [
        field('交易对', `**${symbol}**`),
        field('当前价格', `**${fmtNum(t.last)}**`),
        field('24h 变化', fmtChange(t.changePct)),
        field('24h 低', `**${fmtNum(t.low)}**`),
        field('24h 高', `**${fmtNum(t.high)}**`),
      ],
    },
    HR,
    footer(p, t, ms),
  ]);
}

export function toFeishuMessage(p: FeishuSource, ctx: FeishuContext, secret: string, nowMs = Date.now()): Record<string, unknown> {
  const ms = p.timestamp ?? nowMs;
  const hit = ctx.spec && ctx.values ? detectExtreme(ctx.spec, ctx.values) : null;
  const msg: Record<string, unknown> =
    p.event === 'signal.test' ? testCard(p, ctx.ticker, ms)
    : hit ? extremeCard(p, hit, ctx.ticker, ms)
    : genericCard(p, ctx.ticker, ms);
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
