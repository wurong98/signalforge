/**
 * Window Engine（PRD §21）：按成交时间 T 的滑动窗口增量聚合。
 *
 * 设计：
 * - 每个交易对一条按到达顺序（即 T 单调）的成交缓冲区；
 * - 每个 (window, filter, field) 一个累加器，维护窗口起点指针与 sum/count，
 *   新成交 O(1) 加入，时间推进时 O(k) 淘汰过期成交；
 * - min/max/first/last 基于累加器的窗口区间扫描（V1 数据量下足够）；
 * - 就绪性：连接连续接收时长 ≥ 窗口长度，窗口才被认为是完整的，
 *   否则值为 null，避免启动/重连后用残缺窗口误触发。
 * - ticker 指标不走这套累加：24h 统计由交易所算好后每秒下发，收到第一条即可用，
 *   既不受 60s 窗口上限约束，也不需要预热。
 */
import type { MetricDef, TickerMetric, WindowMetric } from '../../shared/dsl.ts';
import { windowMs } from '../../shared/dsl.ts';

export interface Trade {
  /** aggTrade id */
  a: number;
  /** 成交时间 T（ms） */
  T: number;
  p: number;
  q: number;
  /** buyer is maker：true = 主动卖，false = 主动买 */
  m: boolean;
}

/**
 * Binance `<symbol>@ticker` 的 24h 滚动统计快照。
 * 与 Trade 不同：这是交易所已经算好的终值，收到即有效，本地不做任何聚合。
 */
export interface Ticker {
  /** 事件时间 E（ms） */
  E: number;
  /** c：最新成交价 */
  last: number;
  /** h：24h 最高价 */
  high: number;
  /** l：24h 最低价 */
  low: number;
  /** p：24h 涨跌额 */
  change: number;
  /** P：24h 涨跌幅，已由百分数转为小数（2.345% → 0.02345），与 DSL 百分比约定一致 */
  changePct: number;
  /** v：24h 成交量（base 币） */
  volume: number;
  /** q：24h 成交额（quote 币） */
  quoteVolume: number;
}

type Field = WindowMetric['field'];
const fieldValue = (t: Trade, f: Field) => (f === 'price' ? t.p : f === 'quantity' ? t.q : t.p * t.q);

class Accumulator {
  /** 窗口起点在 buffer 中的绝对下标 */
  start: number;
  sum = 0;
  count = 0;
  constructor(
    readonly ms: number,
    readonly bim: boolean | undefined,
    readonly field: Field,
    start: number,
  ) {
    this.start = start;
  }
  matches(t: Trade) {
    return this.bim === undefined || t.m === this.bim;
  }
}

export type MetricValue = number | null;

export class SymbolWindows {
  private buf: Trade[] = [];
  /** buf[0] 对应的绝对下标 */
  private base = 0;
  private accs = new Map<string, Accumulator>();
  private maxWindowMs = 60_000;
  /** 当前连续接收区间的起点（交易所时间）；null 表示未连接 */
  private continuousSince: number | null = null;
  /** 最近一条 24h ticker 快照；收到第一条之前所有 ticker 指标为 null */
  private tickerSnap: Ticker | null = null;
  now = 0;
  lastTrade: Trade | null = null;

  /** 连接（重新）建立时调用：之前的窗口视为不完整 */
  markContinuous(since: number) {
    this.continuousSince = since;
  }
  markDisconnected() {
    this.continuousSince = null;
  }

  pushTicker(t: Ticker) {
    this.tickerSnap = t;
  }

  get ticker24h() {
    return this.tickerSnap;
  }

  private accFor(m: WindowMetric) {
    const key = `${m.window}|${m.filter.buyer_is_maker}|${m.field}`;
    let acc = this.accs.get(key);
    if (!acc) {
      acc = new Accumulator(windowMs(m.window), m.filter.buyer_is_maker, m.field, this.base);
      // 用缓冲区中已有的数据回填，新建指标无需等待
      const cutoff = this.now - acc.ms;
      for (let i = 0; i < this.buf.length; i++) {
        const t = this.buf[i];
        if (t.T <= cutoff) {
          acc.start = this.base + i + 1;
          continue;
        }
        if (acc.matches(t)) {
          acc.sum += fieldValue(t, acc.field);
          acc.count++;
        }
      }
      this.accs.set(key, acc);
      this.maxWindowMs = Math.max(this.maxWindowMs, acc.ms);
    }
    return acc;
  }

  push(t: Trade) {
    this.buf.push(t);
    this.lastTrade = t;
    for (const acc of this.accs.values()) {
      if (acc.matches(t)) {
        acc.sum += fieldValue(t, acc.field);
        acc.count++;
      }
    }
  }

  /** 推进到交易所时间 now（单调） */
  advance(now: number) {
    if (now < this.now) return;
    this.now = now;
    for (const acc of this.accs.values()) {
      const cutoff = now - acc.ms;
      while (acc.start - this.base < this.buf.length) {
        const t = this.buf[acc.start - this.base];
        if (t.T > cutoff) break;
        if (acc.matches(t)) {
          acc.sum -= fieldValue(t, acc.field);
          acc.count--;
        }
        acc.start++;
      }
      // 浮点累计误差归零
      if (acc.count === 0) acc.sum = 0;
    }
    this.compact();
  }

  private compact() {
    const keepFrom = this.now - this.maxWindowMs;
    let drop = 0;
    while (drop < this.buf.length && this.buf[drop].T <= keepFrom) drop++;
    for (const acc of this.accs.values()) drop = Math.min(drop, acc.start - this.base);
    if (drop > 1024 || (drop > 0 && drop === this.buf.length)) {
      this.buf.splice(0, drop);
      this.base += drop;
    }
  }

  ready(ms: number) {
    return this.continuousSince !== null && this.now - this.continuousSince >= ms;
  }

  /** 计算单个窗口指标；窗口不完整时返回 null */
  window(m: WindowMetric): MetricValue {
    const acc = this.accFor(m);
    if (!this.ready(acc.ms)) return null;
    switch (m.aggregation) {
      case 'sum':
        return acc.sum;
      case 'count':
        return acc.count;
      case 'avg':
        return acc.count ? acc.sum / acc.count : null;
    }
    const from = acc.start - this.base;
    let first: number | null = null;
    let last: number | null = null;
    let min = Infinity;
    let max = -Infinity;
    for (let i = from; i < this.buf.length; i++) {
      const t = this.buf[i];
      if (!acc.matches(t)) continue;
      const v = fieldValue(t, acc.field);
      if (first === null) first = v;
      last = v;
      if (v < min) min = v;
      if (v > max) max = v;
    }
    if (first === null || last === null) return null;
    switch (m.aggregation) {
      case 'first':
        return first;
      case 'last':
        return last;
      case 'min':
        return min;
      case 'max':
        return max;
      case 'delta':
        return last - first;
      case 'return':
        return first === 0 ? null : (last - first) / first;
    }
  }

  /** ticker 指标：交易所侧 24h 终值，没有预热；未收到第一条快照时为 null */
  tickerValue(m: TickerMetric): MetricValue {
    const t = this.tickerSnap;
    if (!t) return null;
    switch (m.field) {
      case 'last_price': return t.last;
      case 'high_24h': return t.high;
      case 'low_24h': return t.low;
      case 'change_24h': return t.change;
      case 'change_pct_24h': return t.changePct;
      case 'volume_24h': return t.volume;
      case 'quote_volume_24h': return t.quoteVolume;
    }
  }

  /** 按定义顺序计算一组指标（combine 只引用在其之前的指标） */
  evaluate(defs: MetricDef[]): Record<string, MetricValue> {
    const out: Record<string, MetricValue> = {};
    for (const d of defs) {
      if (d.kind === 'window') {
        out[d.name] = this.window(d);
        continue;
      }
      if (d.kind === 'ticker') {
        out[d.name] = this.tickerValue(d);
        continue;
      }
      const a = out[d.a];
      const b = out[d.b];
      if (a == null || b == null) {
        out[d.name] = null;
        continue;
      }
      if (d.op === 'diff') out[d.name] = a - b;
      else if (d.op === 'ratio') out[d.name] = b === 0 ? null : a / b;
      else out[d.name] = a + b === 0 ? null : (a - b) / (a + b);
    }
    return out;
  }

  get bufferSize() {
    return this.buf.length;
  }
}
