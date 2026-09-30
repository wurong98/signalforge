/**
 * 内置指标目录：Explore 页面与 LLM Parser 共用。
 * 两类数据源：
 * - window：aggTrade 逐笔成交 + 本地滑动窗口（上限 60s，PRD §30 P0）
 * - ticker：<symbol>@ticker 的 24h 滚动统计，由交易所维护，长周期需求（24h 新低 / 24h 涨跌幅）只能靠它
 * depth / bookTicker 属于 P2。
 */
import type { MetricDef, WindowSpec } from './dsl.ts';

const W: WindowSpec[] = ['1s', '5s', '10s', '30s', '60s'];

function build(): MetricDef[] {
  const out: MetricDef[] = [
    { name: 'last_price', kind: 'window', stream: 'aggTrade', window: '60s', filter: {}, field: 'price', aggregation: 'last' },
  ];
  for (const w of W) {
    out.push({ name: `return_${w}`, kind: 'window', stream: 'aggTrade', window: w, filter: {}, field: 'price', aggregation: 'return' });
  }
  for (const w of W) {
    out.push(
      { name: `buy_notional_${w}`, kind: 'window', stream: 'aggTrade', window: w, filter: { buyer_is_maker: false }, field: 'notional', aggregation: 'sum' },
      { name: `sell_notional_${w}`, kind: 'window', stream: 'aggTrade', window: w, filter: { buyer_is_maker: true }, field: 'notional', aggregation: 'sum' },
      { name: `trade_count_${w}`, kind: 'window', stream: 'aggTrade', window: w, filter: {}, field: 'notional', aggregation: 'count' },
    );
  }
  for (const w of W) {
    out.push(
      { name: `trade_imbalance_${w}`, kind: 'combine', op: 'imbalance', a: `buy_notional_${w}`, b: `sell_notional_${w}` },
      { name: `buy_sell_ratio_${w}`, kind: 'combine', op: 'ratio', a: `buy_notional_${w}`, b: `sell_notional_${w}` },
    );
  }
  // 24h 滚动统计：交易所侧每秒下发，无预热、无 60s 窗口上限
  out.push(
    { name: 'ticker_low_24h', kind: 'ticker', stream: 'ticker', field: 'low_24h' },
    { name: 'ticker_high_24h', kind: 'ticker', stream: 'ticker', field: 'high_24h' },
    { name: 'ticker_change_pct_24h', kind: 'ticker', stream: 'ticker', field: 'change_pct_24h' },
    { name: 'ticker_quote_volume_24h', kind: 'ticker', stream: 'ticker', field: 'quote_volume_24h' },
  );
  return out;
}

export const CATALOG: MetricDef[] = build();
export const CATALOG_BY_NAME = new Map(CATALOG.map((m) => [m.name, m]));

/** Explore 默认展示的指标 */
export const EXPLORE_DEFAULTS = ['last_price', 'buy_notional_10s', 'sell_notional_10s', 'trade_imbalance_10s'];

export const CATALOG_DESCRIPTIONS: Record<string, string> = {
  last_price: '最近一笔成交价',
  return: '窗口内价格收益率 (last - first) / first',
  buy_notional: '主动买入成交额（m = false）',
  sell_notional: '主动卖出成交额（m = true）',
  trade_count: '聚合成交笔数',
  trade_imbalance: '主动买卖失衡 (buy - sell) / (buy + sell)',
  buy_sell_ratio: '主动买入额 / 主动卖出额',
  ticker_low_24h: '24h 最低价（交易所滚动统计）',
  ticker_high_24h: '24h 最高价（交易所滚动统计）',
  ticker_change_pct_24h: '24h 涨跌幅',
  ticker_quote_volume_24h: '24h 成交额（quote 币）',
};

export function catalogDescription(name: string): string {
  const base = name.replace(/_(\d+s)$/, '');
  return CATALOG_DESCRIPTIONS[base] ?? CATALOG_DESCRIPTIONS[name] ?? '';
}
