/**
 * Signal DSL —— 系统内部稳定接口（PRD §9）。
 * LLM Parser、前端、Runtime 都只围绕这里的结构工作。
 */
import { z } from 'zod';

export const WINDOWS = ['1s', '3s', '5s', '10s', '30s', '60s', '5m'] as const;
export type WindowSpec = (typeof WINDOWS)[number];
const UNIT_MS = { s: 1_000, m: 60_000, h: 3_600_000 } as const;
/**
 * 窗口时长换算的唯一入口。窗口名不全是"数字 + s"（5m），
 * 任何地方都不得自行 slice 解析：曾有多处按秒解析，5m 会被静默当成 5s，
 * 导致就绪判定提前、窗口值错误（不变量 4）。
 */
export const windowMs = (w: string) => {
  const m = /^(\d+)([smh])$/.exec(w);
  if (!m) throw new Error(`非法窗口 ${w}`);
  return Number(m[1]) * UNIT_MS[m[2] as keyof typeof UNIT_MS];
};
/** 指标名的窗口后缀，如 buy_notional_10s / volume_delta_5m */
export const WINDOW_SUFFIX_RE = /_(\d+[smh])$/;

/** aggTrade 上可聚合的字段。notional = p × q */
export const FIELDS = ['price', 'quantity', 'notional'] as const;
export const AGGREGATIONS = [
  'sum', 'count', 'avg', 'min', 'max', 'first', 'last',
  /** last - first */
  'delta',
  /** (last - first) / first，即收益率 */
  'return',
] as const;
/** 两个指标组合成的派生指标 */
export const COMBINE_OPS = [
  /** a / b（b = 0 时无值） */
  'ratio',
  /** (a - b) / (a + b)，取值 [-1, 1] */
  'imbalance',
  /** a - b */
  'diff',
] as const;
export const OPERATORS = ['>', '>=', '<', '<=', '=='] as const;
export type Operator = (typeof OPERATORS)[number];

const name = z.string().regex(/^[a-z][a-z0-9_]{0,63}$/, '只允许小写字母、数字、下划线，且以字母开头');

export const WindowMetricSchema = z.object({
  name,
  kind: z.literal('window'),
  stream: z.literal('aggTrade'),
  window: z.enum(WINDOWS),
  /**
   * 过滤条件，保留 Binance 原始语义：
   * buyer_is_maker = false → 主动买（taker 是买方）；true → 主动卖
   */
  filter: z.object({ buyer_is_maker: z.boolean().optional() }).default({}),
  field: z.enum(FIELDS),
  aggregation: z.enum(AGGREGATIONS),
});

export const CombineMetricSchema = z.object({
  name,
  kind: z.literal('combine'),
  op: z.enum(COMBINE_OPS),
  a: name,
  b: name,
});

/**
 * Binance `<symbol>@ticker` 的 24h 滚动统计字段。
 * 与 aggTrade 窗口指标的根本区别：统计由交易所侧维护并每秒推送，
 * 收到的第一条就有效，不需要本地预热，也不受 aggTrade 窗口上限约束。
 */
export const TICKER_FIELDS = [
  /** c：最新成交价 */
  'last_price',
  /** h：24h 最高价 */
  'high_24h',
  /** l：24h 最低价 */
  'low_24h',
  /** p：24h 涨跌额 */
  'change_24h',
  /** P：24h 涨跌幅。DSL 统一用小数（0.05 = +5%），Binance 原值需除以 100 */
  'change_pct_24h',
  /** v：24h 成交量（base 币） */
  'volume_24h',
  /** q：24h 成交额（quote 币，如 USDT） */
  'quote_volume_24h',
] as const;
export type TickerField = (typeof TICKER_FIELDS)[number];

export const TickerMetricSchema = z.object({
  name,
  kind: z.literal('ticker'),
  stream: z.literal('ticker'),
  field: z.enum(TICKER_FIELDS),
});

export const MetricSchema = z.discriminatedUnion('kind', [WindowMetricSchema, CombineMetricSchema, TickerMetricSchema]);
export type WindowMetric = z.infer<typeof WindowMetricSchema>;
export type CombineMetric = z.infer<typeof CombineMetricSchema>;
export type TickerMetric = z.infer<typeof TickerMetricSchema>;
export type MetricDef = z.infer<typeof MetricSchema>;

export const OperandSchema = z.union([
  z.object({ metric: name, multiplier: z.number().finite().default(1) }),
  z.object({ value: z.number().finite() }),
]);
export type Operand = z.infer<typeof OperandSchema>;

export const LeafConditionSchema = z.object({
  left: name,
  operator: z.enum(OPERATORS),
  right: OperandSchema,
});
export type LeafCondition = z.infer<typeof LeafConditionSchema>;

export type Condition = LeafCondition | { op: 'and' | 'or'; conditions: Condition[] };
export const ConditionSchema: z.ZodType<Condition> = z.lazy(() =>
  z.union([
    LeafConditionSchema,
    z.object({ op: z.enum(['and', 'or']), conditions: z.array(ConditionSchema).min(1).max(8) }),
  ]),
);
export const isLeaf = (c: Condition): c is LeafCondition => 'left' in c;

export const SYMBOL_RE = /^[A-Z0-9]{5,20}$/;

/**
 * 市场：spot = 币安现货；futures = 币安 U 本位永续合约（USDⓈ-M PERPETUAL）。
 * 同名交易对（如 BTCUSDT）在两个市场是不同的行情，系统内部用"市场键"区分：
 * 现货即 symbol，合约加 `.P` 后缀（与 TradingView 写法一致，如 BTCUSDT.P）。
 * 窗口、指标历史、事件、助手工具都按市场键隔离。
 */
export const PRODUCTS = ['spot', 'futures'] as const;
export type Product = (typeof PRODUCTS)[number];
export const FUTURES_SUFFIX = '.P';
export const MARKET_KEY_RE = /^[A-Z0-9]{5,20}(\.P)?$/;
export const marketKey = (m: { product: Product; symbol: string }) => (m.product === 'futures' ? `${m.symbol}${FUTURES_SUFFIX}` : m.symbol);
export function parseMarketKey(key: string): { product: Product; symbol: string } {
  return key.endsWith(FUTURES_SUFFIX) ? { product: 'futures', symbol: key.slice(0, -FUTURES_SUFFIX.length) } : { product: 'spot', symbol: key };
}
export const productLabel = (p: Product) => (p === 'futures' ? 'USDⓈ-M Perpetual' : 'Spot');

export const SignalSpecSchema = z.object({
  name: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/, 'slug：小写字母、数字、中划线'),
  title: z.string().min(1).max(80),
  description: z.string().max(500).default(''),
  market: z.object({
    exchange: z.literal('binance'),
    // 已存库的 spec 都是 spot，新增 futures 向后兼容
    product: z.enum(PRODUCTS),
    symbol: z.string().regex(SYMBOL_RE),
  }),
  metrics: z.array(MetricSchema).min(1).max(16),
  condition: ConditionSchema,
  /** 触发后冷却时长（毫秒） */
  cooldown_ms: z.number().int().min(0).max(24 * 3600_000).default(10_000),
});
export type SignalSpec = z.infer<typeof SignalSpecSchema>;

/** 结构校验之外的语义校验：引用存在、无环、窗口合法 */
export function validateSpec(input: unknown): { ok: true; spec: SignalSpec } | { ok: false; errors: string[] } {
  const parsed = SignalSpecSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, errors: parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`) };
  }
  const spec = parsed.data;
  const errors: string[] = [];
  const names = new Set<string>();
  for (const m of spec.metrics) {
    if (names.has(m.name)) errors.push(`metrics: 重复的指标名 ${m.name}`);
    // combine 只能引用已在它之前定义的指标，天然保证无环
    if (m.kind === 'combine') {
      for (const ref of [m.a, m.b]) if (!names.has(ref)) errors.push(`metrics.${m.name}: 引用了未定义（或定义在其后）的指标 ${ref}`);
    }
    if (m.kind === 'window' && m.field !== 'price' && (m.aggregation === 'return' || m.aggregation === 'delta')) {
      errors.push(`metrics.${m.name}: ${m.aggregation} 只适用于 price 字段`);
    }
    names.add(m.name);
  }
  const walk = (c: Condition) => {
    if (isLeaf(c)) {
      if (!names.has(c.left)) errors.push(`condition: 未定义的指标 ${c.left}`);
      if ('metric' in c.right && !names.has(c.right.metric)) errors.push(`condition: 未定义的指标 ${c.right.metric}`);
    } else c.conditions.forEach(walk);
  };
  walk(spec.condition);
  return errors.length ? { ok: false, errors } : { ok: true, spec };
}

// ---------- 人类可读描述（Explain / 透明性，PRD §12 §19） ----------

export function describeOperand(o: Operand): string {
  if ('value' in o) return String(o.value);
  return o.multiplier === 1 ? o.metric : `${o.metric} × ${o.multiplier}`;
}

export function describeCondition(c: Condition): string {
  if (isLeaf(c)) return `${c.left} ${c.operator} ${describeOperand(c.right)}`;
  const parts = c.conditions.map((x) => (isLeaf(x) ? describeCondition(x) : `(${describeCondition(x)})`));
  return parts.join(c.op === 'and' ? ' AND ' : ' OR ');
}

const FIELD_EXPR: Record<(typeof FIELDS)[number], string> = {
  price: 'price',
  quantity: 'quantity',
  notional: 'price × quantity',
};

const TICKER_EXPR: Record<TickerField, string> = {
  last_price: 'TICKER.c',
  high_24h: 'TICKER.h',
  low_24h: 'TICKER.l',
  change_24h: 'TICKER.p',
  change_pct_24h: 'TICKER.P / 100',
  volume_24h: 'TICKER.v',
  quote_volume_24h: 'TICKER.q',
};

/** 指标 → 公式 → 原始数据 → Binance Stream 的可追溯描述 */
export function describeFormula(m: MetricDef): string {
  if (m.kind === 'combine') {
    if (m.op === 'ratio') return `${m.a} / ${m.b}`;
    if (m.op === 'diff') return `${m.a} - ${m.b}`;
    return `(${m.a} - ${m.b}) / (${m.a} + ${m.b})`;
  }
  if (m.kind === 'ticker') {
    // 交易所侧维护的 24h 滚动统计，收到即有效，没有预热概念
    return `${TICKER_EXPR[m.field]}\nSTREAM @ticker · 24h 滚动统计（交易所侧维护，无预热）`;
  }
  const expr = FIELD_EXPR[m.field];
  const agg: Record<(typeof AGGREGATIONS)[number], string> = {
    sum: `SUM(${expr})`,
    count: 'COUNT(*)',
    avg: `AVG(${expr})`,
    min: `MIN(${expr})`,
    max: `MAX(${expr})`,
    first: `FIRST(${expr})`,
    last: `LAST(${expr})`,
    delta: `LAST(${expr}) - FIRST(${expr})`,
    return: `(LAST(${expr}) - FIRST(${expr})) / FIRST(${expr})`,
  };
  const where =
    m.filter.buyer_is_maker === undefined
      ? ''
      : `\nWHERE m (buyer_is_maker) = ${m.filter.buyer_is_maker}  -- ${m.filter.buyer_is_maker ? '主动卖出' : '主动买入'}`;
  return `${agg[m.aggregation]}${where}\nWINDOW ${m.window} (按成交时间 T 滑动)`;
}

export function metricUnit(m: MetricDef, all: MetricDef[]): string {
  if (m.kind === 'combine') {
    if (m.op === 'ratio') return 'x';
    if (m.op === 'imbalance') return '';
    const a = all.find((x) => x.name === m.a);
    return a ? metricUnit(a, all) : '';
  }
  if (m.kind === 'ticker') {
    if (m.field === 'change_pct_24h') return '%';
    if (m.field === 'volume_24h') return 'base';
    return 'USDT';
  }
  if (m.aggregation === 'count') return 'trades';
  if (m.aggregation === 'return') return '%';
  if (m.field === 'notional') return 'USDT';
  if (m.field === 'quantity') return 'base';
  return 'USDT';
}

// ---------- Webhook ----------

export const WebhookInputSchema = z.object({
  name: z.string().min(1).max(80),
  url: z.url({ protocol: /^https?$/ }),
  method: z.enum(['POST', 'PUT']).default('POST'),
  headers: z.record(z.string(), z.string()).default({}),
  secret: z.string().max(256).default(''),
  timeout_ms: z.number().int().min(500).max(30_000).default(5_000),
  max_retries: z.number().int().min(0).max(3).default(3),
});
export type WebhookInput = z.infer<typeof WebhookInputSchema>;

/** 重试退避（PRD §25）：第 1/2/3 次重试分别在 1s / 5s / 30s 后 */
export const RETRY_DELAYS_MS = [1_000, 5_000, 30_000];
