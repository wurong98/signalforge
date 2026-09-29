/**
 * 规则解析器：LLM 不可用时的确定性兜底，覆盖 V1 核心 Demo 的句式：
 *   "BTC 10 秒主动买入金额超过主动卖出金额 3 倍时通知我"
 *   "ETH 5 秒内涨幅超过 0.2%"
 */
import type { MetricDef, SignalSpec, WindowSpec } from '../../shared/dsl.ts';
import { WINDOWS } from '../../shared/dsl.ts';

export interface ParseOutput {
  spec: SignalSpec;
  explanation: string;
  assumptions: string[];
  parser: 'llm' | 'rules';
}

const KNOWN_BASES = ['BTC', 'ETH', 'SOL', 'BNB', 'XRP', 'DOGE', 'ADA', 'TRX', 'AVAX', 'LINK', 'TON', 'SUI', 'PEPE'];

export function detectSymbol(text: string): { symbol: string; assumed: boolean } {
  const up = text.toUpperCase();
  const pair = up.match(/\b([A-Z0-9]{2,10})(USDT|USDC|FDUSD|BTC)\b/);
  if (pair) return { symbol: pair[0], assumed: false };
  for (const b of KNOWN_BASES) if (new RegExp(`(^|[^A-Z])${b}([^A-Z]|$)`).test(up)) return { symbol: `${b}USDT`, assumed: false };
  if (/比特币/.test(text)) return { symbol: 'BTCUSDT', assumed: false };
  if (/以太坊?/.test(text)) return { symbol: 'ETHUSDT', assumed: false };
  return { symbol: 'BTCUSDT', assumed: true };
}

export function detectWindow(text: string): { window: WindowSpec; assumed: boolean; note?: string } {
  const m = text.match(/(\d+)\s*(秒|s\b|sec|seconds?|分钟|min|minutes?)/i);
  if (!m) return { window: '10s', assumed: true };
  let sec = Number(m[1]);
  if (/分|min/i.test(m[2])) sec *= 60;
  const allowed = WINDOWS.map((w) => Number(w.slice(0, -1)));
  if (allowed.includes(sec)) return { window: `${sec}s` as WindowSpec, assumed: false };
  const nearest = allowed.reduce((a, b) => (Math.abs(b - sec) < Math.abs(a - sec) ? b : a));
  return { window: `${nearest}s` as WindowSpec, assumed: true, note: `窗口 ${sec}s 不在支持列表，已取最接近的 ${nearest}s` };
}

function detectCooldown(text: string): number | null {
  const m = text.match(/冷却\s*(\d+)\s*(秒|s|分钟|min)/i) ?? text.match(/cooldown\s*(\d+)\s*(s|min)/i);
  if (!m) return null;
  return Number(m[1]) * (/分|min/i.test(m[2]) ? 60_000 : 1_000);
}

/**
 * 相对比较（A > B × N）在成交稀少时会被极小金额触发（B = 0 时任意 A > 0 都成立），
 * 因此默认附加一个绝对成交额下限：10s 基准按币种给出，随窗口线性缩放。
 */
export function noiseFloor(symbol: string, w: WindowSpec): number {
  const per10s = symbol.startsWith('BTC') ? 50_000 : symbol.startsWith('ETH') ? 20_000 : 5_000;
  return Math.max(100, Math.round((per10s * Number(w.slice(0, -1))) / 10));
}

export function parseWithRules(text: string): ParseOutput | { error: string } {
  const { symbol, assumed: symAssumed } = detectSymbol(text);
  const win = detectWindow(text);
  const w = win.window;
  const base = symbol.replace(/(USDT|USDC|FDUSD|BTC)$/, '').toLowerCase() || 'x';
  const assumptions: string[] = [];
  if (symAssumed) assumptions.push('未识别到交易对，默认 BTCUSDT');
  if (win.assumed) assumptions.push(win.note ?? '未指定时间窗口，默认 10s');
  const cooldown = detectCooldown(text) ?? 10_000;

  const mult = text.match(/(\d+(?:\.\d+)?)\s*(倍|x\b|×|times)/i);
  const hasBuy = /买/.test(text) || /\bbuy/i.test(text);
  const hasSell = /卖/.test(text) || /\bsell/i.test(text);
  const market = { exchange: 'binance' as const, product: 'spot' as const, symbol };

  if (mult && hasBuy && hasSell) {
    const k = Number(mult[1]);
    const buyFirst = text.search(/买|buy/i) < text.search(/卖|sell/i);
    const buy: MetricDef = { name: `buy_notional_${w}`, kind: 'window', stream: 'aggTrade', window: w, filter: { buyer_is_maker: false }, field: 'notional', aggregation: 'sum' };
    const sell: MetricDef = { name: `sell_notional_${w}`, kind: 'window', stream: 'aggTrade', window: w, filter: { buyer_is_maker: true }, field: 'notional', aggregation: 'sum' };
    const [l, r] = buyFirst ? [buy, sell] : [sell, buy];
    const side = buyFirst ? 'buy' : 'sell';
    const floor = noiseFloor(symbol, w);
    assumptions.push(`为避免成交稀少时误触发，额外要求 ${w} 主动${buyFirst ? '买入' : '卖出'}额 ≥ ${floor.toLocaleString('en-US')} USDT（可修改）`);
    return {
      parser: 'rules',
      assumptions,
      spec: {
        name: `${base}-${side}-pressure-${w}`,
        title: `${base.toUpperCase()} ${buyFirst ? 'Buy' : 'Sell'} Pressure ${w}`,
        description: text,
        market,
        metrics: [buy, sell],
        condition: {
          op: 'and',
          conditions: [
            { left: l.name, operator: '>', right: { metric: r.name, multiplier: k } },
            { left: l.name, operator: '>=', right: { value: floor } },
          ],
        },
        cooldown_ms: cooldown,
      },
      explanation: `在 ${symbol} 的 aggTrade 成交流上，统计最近 ${w} 的主动${buyFirst ? '买入' : '卖出'}成交额（Σ price × quantity，m = ${!buyFirst}），当它超过主动${buyFirst ? '卖出' : '买入'}成交额的 ${k} 倍时触发。`,
    };
  }

  const pct = text.match(/(涨|跌|上涨|下跌|rise|drop|up|down)[^\d-]*(\d+(?:\.\d+)?)\s*%/i) ?? text.match(/(\d+(?:\.\d+)?)\s*%/);
  if (pct) {
    const num = Number(pct[2] ?? pct[1]);
    const down = /跌|drop|down/i.test(text);
    const metric: MetricDef = { name: `return_${w}`, kind: 'window', stream: 'aggTrade', window: w, filter: {}, field: 'price', aggregation: 'return' };
    return {
      parser: 'rules',
      assumptions,
      spec: {
        name: `${base}-${down ? 'drop' : 'pump'}-${w}`,
        title: `${base.toUpperCase()} ${down ? 'Drop' : 'Pump'} ${num}% in ${w}`,
        description: text,
        market,
        metrics: [metric],
        condition: down
          ? { left: metric.name, operator: '<=', right: { value: -num / 100 } }
          : { left: metric.name, operator: '>=', right: { value: num / 100 } },
        cooldown_ms: cooldown,
      },
      explanation: `在 ${symbol} 的 aggTrade 上计算最近 ${w} 的价格收益率 (last - first) / first，${down ? `跌幅达到 ${num}%` : `涨幅达到 ${num}%`} 时触发。`,
    };
  }

  return { error: '规则解析器无法理解该描述。请配置 LLM（LLM_BASE_URL / LLM_API_KEY），或使用"X 秒主动买入超过卖出 N 倍"/"X 秒涨幅超过 N%"句式。' };
}
