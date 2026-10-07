/**
 * 规则解析器：LLM 不可用时的确定性兜底，覆盖 V1 核心 Demo 的句式：
 *   "BTC 10 秒主动买入金额超过主动卖出金额 3 倍时通知我"
 *   "ETH 5 秒内涨幅超过 0.2%"
 *   "BTC 创 24 小时新低时提醒我，每分钟最多一次"
 *   "XPL 5 分钟涨幅超过 2% 且 CVD 为正" / "XPL 5 分钟上涨但 CVD 为负"
 */
import type { MetricDef, SignalSpec, WindowSpec } from '../../shared/dsl.ts';
import { WINDOWS, windowMs } from '../../shared/dsl.ts';

export interface ParseOutput {
  spec: SignalSpec;
  explanation: string;
  assumptions: string[];
  parser: 'llm' | 'rules';
}

const KNOWN_BASES = ['BTC', 'ETH', 'SOL', 'BNB', 'XRP', 'DOGE', 'ADA', 'TRX', 'AVAX', 'LINK', 'TON', 'SUI', 'PEPE', 'XPL'];

/** "24 小时 / 24h / 一天 / 日内" 这类长周期说法 */
const PERIOD_24H = /(24\s*(?:小时|小時|h\b|hours?\b|hr)|24h|一天|日内)/i;

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
  let ms = Number(m[1]) * 1000;
  if (/分|min/i.test(m[2])) ms *= 60;
  // 按毫秒比较并返回 WINDOWS 里的原名：窗口名不全是"秒数 + s"（5m），不能拼 `${sec}s`
  const exact = WINDOWS.find((w) => windowMs(w) === ms);
  if (exact) return { window: exact, assumed: false };
  const nearest = WINDOWS.reduce((a, b) => (Math.abs(windowMs(b) - ms) < Math.abs(windowMs(a) - ms) ? b : a));
  return { window: nearest, assumed: true, note: `窗口 ${m[1]}${m[2]} 不在支持列表，已取最接近的 ${nearest}` };
}

/** DSL 上限：cooldown_ms ≤ 24h */
const MAX_COOLDOWN_MS = 24 * 3600_000;

function detectCooldown(text: string): number | null {
  const m =
    text.match(/冷却\s*(\d+)\s*(秒|分钟|min|小时|hours?|s|h)/i) ??
    text.match(/cooldown\s*(\d+)\s*(min|hours?|s|h)/i) ??
    // "每分钟最多一次" / "每 30 秒提醒一次" / "每小时最多一次"：省略数字时按 1 计。
    // 必须在同一分句内跟着"一次/最多"等限频词：否则"每 30 秒成交额超过…"这种描述统计口径的说法
    // 会被误读成冷却时间。
    text.match(/每\s*(\d+)?\s*(秒|分钟|min|小时|hours?|s\b|h\b)[^，,。;；]*?(一次|最多|至多|不超过)/i);
  if (!m) return null;
  const n = m[1] === undefined ? 1 : Number(m[1]);
  const unit = /分|min/i.test(m[2]) ? 60_000 : /小时|hour|^h$/i.test(m[2]) ? 3600_000 : 1_000;
  return Math.min(n * unit, MAX_COOLDOWN_MS);
}

/**
 * 相对比较（A > B × N）在成交稀少时会被极小金额触发（B = 0 时任意 A > 0 都成立），
 * 因此默认附加一个绝对成交额下限：10s 基准按币种给出，随窗口线性缩放。
 */
export function noiseFloor(symbol: string, w: WindowSpec): number {
  const per10s = symbol.startsWith('BTC') ? 50_000 : symbol.startsWith('ETH') ? 20_000 : 5_000;
  return Math.max(100, Math.round((per10s * windowMs(w)) / 10_000));
}

/**
 * 24h 档：aggTrade 窗口最长 5m，表达不了"24 小时新低"这类长周期需求，
 * 必须用 <symbol>@ticker 的交易所侧 24h 滚动统计（每秒下发，收到第一条即有效，无需预热）。
 * 返回 null 表示不是 24h 档，交回窗口分支。
 */
function parse24h(
  text: string,
  symbol: string,
  base: string,
  market: SignalSpec['market'],
  cooldown: number,
  assumptions: string[],
): ParseOutput | null {
  if (!PERIOD_24H.test(text)) return null;

  const isLow = /(新低|创新低|最低价|跌破)/.test(text);
  const isHigh = /(新高|创新高|最高价|突破)/.test(text);
  if (isLow || isHigh) {
    // 最近 1s 的最新成交价 与 ticker 尚未更新的 24h 极值比较。
    // 必须用严格不等号：成交价"等于"ticker 上的极值只是恰好停在那儿，不是创新低；
    // 而创新低的那一笔一定严格小于旧极值（ticker 还没来得及跟上），
    // 随后 ticker 刷新到新低后条件立刻解除 —— 于是每一次创新低都是一条干净的"假→真"边沿，
    // 真正的限频交给 cooldown。若用 <=，连续下跌中条件会一直为真，整个过程只会在第一次弹一下时触发一次。
    const last: MetricDef = { name: 'last_1s', kind: 'window', stream: 'aggTrade', window: '1s', filter: {}, field: 'price', aggregation: 'last' };
    const extreme: MetricDef = { name: isLow ? 'low_24h' : 'high_24h', kind: 'ticker', stream: 'ticker', field: isLow ? 'low_24h' : 'high_24h' };
    const zh = isLow ? '新低' : '新高';
    assumptions.push(`以最近 1 秒最新成交价对比交易所 24h ${isLow ? '最低' : '最高'}价；每次创新${zh}的边沿触发一次，${cooldown / 1000} 秒冷却内不重复`);
    return {
      parser: 'rules',
      assumptions,
      spec: {
        name: `${base}-24h-${isLow ? 'new-low' : 'new-high'}`,
        title: `${base.toUpperCase()} 24h ${isLow ? 'New Low' : 'New High'}`,
        description: text,
        market,
        metrics: [last, extreme],
        condition: {
          left: last.name,
          operator: isLow ? '<' : '>',
          right: { metric: extreme.name, multiplier: 1 },
        },
        cooldown_ms: cooldown,
      },
      explanation: `${symbol}：aggTrade 取最近 1 秒的最新成交价 LAST(price)，<symbol>@ticker（交易所每秒推送）取 24h ${isLow ? '最低' : '最高'}价；新成交价严格${isLow ? '低于' : '高于'} ticker 上的 24h 极值，说明刚刚创下 24 小时${zh}（ticker 下一秒即刷新到新极值，条件随之解除）。`,
    };
  }

  // 24h 涨跌幅：已确认是 24h 档且不是新高/新低，剩下的百分比就只能是 24h 涨跌幅。
  // 但若同时出现了显式短窗口（"24h 内 10 秒急拉"），那是"长周期 + 短窗口"的组合，
  // 交给窗口分支，与 LLM 提示词里"用 AND 组合"的做法保持一致。
  const pct = text.match(/(涨|跌|上涨|下跌|rise|drop|up|down)[^\d-]*(\d+(?:\.\d+)?)\s*%/i) ?? text.match(/(\d+(?:\.\d+)?)\s*%/);
  const hasShortWindow = /(\d+)\s*(?:秒|s\b|sec|seconds?|分钟|min|minutes?)/i.test(text);
  if (pct && !hasShortWindow) {
    const num = Number(pct[2] ?? pct[1]);
    // "涨跌幅" 同时含涨跌两个字；只说"涨跌幅"应理解为双向波动
    // 英文词加单词边界：否则 "supply" / "update" 里的 up 会被当成方向
    const up = /涨幅|上涨|涨了|涨超|\brises?\b|\bup\b/i.test(text) && !/跌|\bdrops?\b|\bdown\b/i.test(text);
    const down = /跌幅|下跌|跌了|跌超|\bdrops?\b|\bdown\b/i.test(text) && !/涨|\brises?\b|\bup\b/i.test(text);
    const metric: MetricDef = { name: 'change_pct_24h', kind: 'ticker', stream: 'ticker', field: 'change_pct_24h' };
    const both: SignalSpec['condition'] = {
      op: 'or',
      conditions: [
        { left: metric.name, operator: '>=', right: { value: num / 100 } },
        { left: metric.name, operator: '<=', right: { value: -num / 100 } },
      ],
    };
    return {
      parser: 'rules',
      assumptions,
      spec: {
        // slug 只允许 [a-z0-9-]：小数点换成 p（2.5% → 2p5pct），否则 validateSpec 直接拒绝
        name: `${base}-24h-${up ? 'pump' : down ? 'drop' : 'swing'}-${String(num).replace('.', 'p')}pct`,
        title: `${base.toUpperCase()} 24h ${up ? 'Rise' : down ? 'Drop' : 'Swing'} ${num}%`,
        description: text,
        market,
        metrics: [metric],
        condition: up
          ? { left: metric.name, operator: '>=', right: { value: num / 100 } }
          : down
            ? { left: metric.name, operator: '<=', right: { value: -num / 100 } }
            : both,
        cooldown_ms: cooldown,
      },
      explanation: `${symbol} 的 <symbol>@ticker 流给出交易所维护的 24h 涨跌幅（DSL 内为小数，5% 记作 0.05），${up ? `涨幅达到 ${num}%` : down ? `跌幅达到 ${num}%` : `向上或向下偏离超过 ${num}%`} 时触发。`,
    };
  }
  return null;
}

export function parseWithRules(text: string): ParseOutput | { error: string } {
  const { symbol, assumed: symAssumed } = detectSymbol(text);
  const base = symbol.replace(/(USDT|USDC|FDUSD|BTC)$/, '').toLowerCase() || 'x';
  const assumptions: string[] = [];
  if (symAssumed) assumptions.push('未识别到交易对，默认 BTCUSDT');
  const market = { exchange: 'binance' as const, product: 'spot' as const, symbol };
  const cooldown = detectCooldown(text) ?? 10_000;

  // 24h 档先于窗口分支判断：否则"24 小时新低"会被降级成短窗口近似，语义完全不同
  const t24 = parse24h(text, symbol, base, market, cooldown, assumptions);
  if (t24) return t24;

  const win = detectWindow(text);
  const w = win.window;
  if (win.assumed) assumptions.push(win.note ?? '未指定时间窗口，默认 10s');

  const mult = text.match(/(\d+(?:\.\d+)?)\s*(倍|x\b|×|times)/i);
  const hasBuy = /买/.test(text) || /\bbuy/i.test(text);
  const hasSell = /卖/.test(text) || /\bsell/i.test(text);

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

  // CVD 分支须先于纯涨幅分支：否则"涨 2% 且 CVD 为正"会命中下面的百分比句式，
  // 静默丢掉 CVD 条件，生成一个只看涨幅的 Signal
  if (/cvd|volume[\s_]*delta|主动净|净买|净卖/i.test(text)) return parseCvd(text, symbol, base, market, w, cooldown, assumptions);

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

/**
 * 窗口 CVD（volume_delta = 主动买入额 - 主动卖出额）与价格方向的组合。
 * 价格部分：给了百分比就按阈值；只说"上涨/下跌"就取 > 0 / < 0；没提价格就只看 CVD。
 */
function parseCvd(
  text: string,
  symbol: string,
  base: string,
  market: SignalSpec['market'],
  w: WindowSpec,
  cooldown: number,
  assumptions: string[],
): ParseOutput {
  const negative = /(cvd|delta)[^，,。;；]*?(为负|负值|转负|小于\s*0|<\s*0)|净卖|背离/i.test(text);
  const buy: MetricDef = { name: `buy_notional_${w}`, kind: 'window', stream: 'aggTrade', window: w, filter: { buyer_is_maker: false }, field: 'notional', aggregation: 'sum' };
  const sell: MetricDef = { name: `sell_notional_${w}`, kind: 'window', stream: 'aggTrade', window: w, filter: { buyer_is_maker: true }, field: 'notional', aggregation: 'sum' };
  const delta: MetricDef = { name: `volume_delta_${w}`, kind: 'combine', op: 'diff', a: buy.name, b: sell.name };
  const ret: MetricDef = { name: `return_${w}`, kind: 'window', stream: 'aggTrade', window: w, filter: {}, field: 'price', aggregation: 'return' };
  const conditions: SignalSpec['condition'][] = [];
  const pct = text.match(/(\d+(?:\.\d+)?)\s*%/);
  const down = /跌|\bdrops?\b|\bdown\b/i.test(text);
  const up = /涨|\brises?\b|\bup\b/i.test(text);
  let priceDesc = '';
  if (pct) {
    const num = Number(pct[1]);
    conditions.push(down ? { left: ret.name, operator: '<=', right: { value: -num / 100 } } : { left: ret.name, operator: '>=', right: { value: num / 100 } });
    priceDesc = `${w} ${down ? '跌幅' : '涨幅'}达到 ${num}%`;
  } else if (up || down) {
    conditions.push({ left: ret.name, operator: down ? '<' : '>', right: { value: 0 } });
    priceDesc = `${w} 价格${down ? '下跌' : '上涨'}`;
  }
  conditions.push({ left: delta.name, operator: negative ? '<' : '>', right: { value: 0 } });
  const floor = noiseFloor(symbol, w);
  assumptions.push(`CVD 按 ${w} 窗口计算（窗口内主动买卖净额），不是从启动起无限累计的绝对值`);
  assumptions.push(`阈值取 0，成交清淡时符号容易在 0 附近来回翻转；如需过滤噪声可改为 ${negative ? '<' : '>'} ${negative ? '-' : ''}${floor.toLocaleString('en-US')} USDT 等绝对阈值`);
  const tag = negative ? 'neg' : 'pos';
  return {
    parser: 'rules',
    assumptions,
    spec: {
      name: `${base}-cvd-${tag}-${w}`,
      title: `${base.toUpperCase()} ${priceDesc ? (down ? 'Drop' : 'Pump') + ' + ' : ''}CVD ${negative ? 'Negative' : 'Positive'} ${w}`,
      description: text,
      market,
      metrics: priceDesc ? [buy, sell, delta, ret] : [buy, sell, delta],
      condition: conditions.length === 1 ? conditions[0] : { op: 'and', conditions },
      cooldown_ms: cooldown,
    },
    explanation: `在 ${symbol} 的 aggTrade 上统计最近 ${w} 的主动买入额 Σ(p×q | m=false) 与主动卖出额 Σ(p×q | m=true)，二者之差为窗口 CVD（volume_delta_${w}）；${priceDesc ? `${priceDesc}且` : ''}CVD ${negative ? '< 0（主动卖盘净流出）' : '> 0（主动买盘净流入）'}时触发。`,
  };
}
