/**
 * Runtime Engine（PRD §20）：
 *   Binance Event → Metric Update → Signal Evaluation → Event → Webhook
 * 完全确定性，不经过 LLM。
 */
import { EventEmitter } from 'node:events';
import { CATALOG } from '../../shared/catalog.ts';
import type { SignalSpec } from '../../shared/dsl.ts';
import { describeCondition } from '../../shared/dsl.ts';
import type { BinanceHub } from '../binance/stream.ts';
import type { Db, EventRow, SignalRow } from '../db.ts';
import type { WebhookDispatcher } from '../webhook/delivery.ts';
import type { EvalResult, SignalState } from './signal.ts';
import { SignalStateMachine, evaluateCondition, gauge, requiresTicker, requiredWindowMs } from './signal.ts';
import type { MetricValue, Ticker, Trade } from './window.ts';
import { SymbolWindows } from './window.ts';

const TICK_MS = 200;
const SAMPLE_MS = 1_000;
const SERIES_LEN = 3_600;
const FLUSH_MS = 5_000;

class Series {
  ts: number[] = [];
  v: (number | null)[] = [];
  push(t: number, x: number | null) {
    this.ts.push(t);
    this.v.push(x);
    if (this.ts.length > SERIES_LEN) {
      this.ts.shift();
      this.v.shift();
    }
  }
  since(from: number) {
    const out: [number, number | null][] = [];
    for (let i = 0; i < this.ts.length; i++) if (this.ts[i] >= from) out.push([this.ts[i], this.v[i]]);
    return out;
  }
  get oldest() {
    return this.ts[0] ?? Infinity;
  }
}

interface Clock {
  lastE: number;
  recvLocal: number;
  awaitingFirst: boolean;
}

export interface RunnerStatus {
  id: number;
  name: string;
  symbol: string;
  enabled: boolean;
  state: SignalState | 'DISABLED';
  ready: boolean;
  last_eval_local: number | null;
  last_event_ts: number | null;
  values: Record<string, MetricValue>;
  gauge: ReturnType<typeof gauge>;
  error: string | null;
}

class Runner {
  sm: SignalStateMachine;
  lastEvalLocal: number | null = null;
  lastEventTs: number | null;
  values: Record<string, MetricValue> = {};
  result: EvalResult | null = null;
  ready = false;
  error: string | null = null;
  readonly needMs: number;
  readonly needTicker: boolean;
  constructor(public row: SignalRow, lastEventTs: number | null) {
    this.sm = new SignalStateMachine(row.spec.cooldown_ms);
    this.needMs = requiredWindowMs(row.spec);
    this.needTicker = requiresTicker(row.spec);
    this.lastEventTs = lastEventTs;
  }
}

export class Runtime extends EventEmitter {
  private windows = new Map<string, SymbolWindows>();
  private clocks = new Map<string, Clock>();
  private runners = new Map<number, Runner>();
  private series = new Map<string, Series>();
  private pending: { symbol: string; metric: string; ts: number; value: number | null }[] = [];
  private timers: NodeJS.Timeout[] = [];

  constructor(
    private db: Db,
    private hub: BinanceHub,
    private dispatcher: WebhookDispatcher,
    private baseSymbols: string[],
    private retentionDays: number,
  ) {
    super();
    hub.on('trade', (s, t, E, recv) => this.onTrade(s, t, E, recv));
    // ticker 不参与成交窗口的时钟与预热，只更新 24h 快照后立刻重算（边沿要抓得准）
    hub.on('ticker', (s, t) => this.onTicker(s, t));
    hub.on('connected', (symbols) => {
      for (const s of symbols) {
        const c = this.clock(s);
        c.awaitingFirst = true;
      }
    });
    hub.on('disconnected', () => {
      for (const w of this.windows.values()) w.markDisconnected();
      this.evaluateAll();
    });
  }

  start() {
    for (const s of this.baseSymbols) this.win(s);
    this.sync();
    this.hub.start([...this.symbolsInUse()]);
    this.timers.push(setInterval(() => this.tick(), TICK_MS));
    this.timers.push(setInterval(() => this.sample(), SAMPLE_MS));
    this.timers.push(setInterval(() => this.flush(), FLUSH_MS));
    this.timers.push(setInterval(() => this.db.pruneMetricPoints(Date.now() - this.retentionDays * 86_400_000), 3_600_000));
  }

  stop() {
    this.timers.forEach(clearInterval);
    this.flush();
    this.hub.stop();
  }

  private win(symbol: string) {
    let w = this.windows.get(symbol);
    if (!w) {
      w = new SymbolWindows();
      this.windows.set(symbol, w);
    }
    return w;
  }
  private clock(symbol: string) {
    let c = this.clocks.get(symbol);
    if (!c) {
      c = { lastE: 0, recvLocal: 0, awaitingFirst: true };
      this.clocks.set(symbol, c);
    }
    return c;
  }

  /** 估计当前交易所时间：最近事件时间 + 本地流逝时间 */
  private nowEx(symbol: string) {
    const c = this.clocks.get(symbol);
    if (!c || !c.recvLocal) return Date.now();
    return c.lastE + (Date.now() - c.recvLocal);
  }

  private symbolsInUse() {
    const s = new Set(this.baseSymbols);
    for (const r of this.runners.values()) s.add(r.row.spec.market.symbol);
    return s;
  }

  /** 从数据库同步 Signal 定义（创建 / 编辑 / 启停 / 删除后调用） */
  sync() {
    const rows = this.db.listSignals().filter((r) => r.enabled);
    const keep = new Set<number>();
    for (const row of rows) {
      keep.add(row.id);
      const cur = this.runners.get(row.id);
      if (cur && cur.row.version === row.version) {
        cur.row = row; // webhook 绑定等非规格字段
        continue;
      }
      this.runners.set(row.id, new Runner(row, this.db.lastEventTs(row.id)));
    }
    for (const id of [...this.runners.keys()]) if (!keep.has(id)) this.runners.delete(id);
    const inUse = this.symbolsInUse();
    for (const s of inUse) {
      this.win(s);
      this.hub.ensure(s);
    }
    for (const s of [...this.windows.keys()]) {
      if (!inUse.has(s)) {
        this.hub.release(s);
        this.windows.delete(s);
        this.clocks.delete(s);
      }
    }
    this.emit('changed');
  }

  private onTrade(symbol: string, t: Trade, E: number, recv: number) {
    const w = this.windows.get(symbol);
    if (!w) return;
    const c = this.clock(symbol);
    c.lastE = E;
    c.recvLocal = recv;
    if (c.awaitingFirst) {
      c.awaitingFirst = false;
      w.markContinuous(E);
    }
    w.push(t);
    w.advance(this.nowEx(symbol));
    this.evaluateSymbol(symbol);
  }

  private onTicker(symbol: string, t: Ticker) {
    const w = this.windows.get(symbol);
    if (!w) return;
    w.pushTicker(t);
    this.evaluateSymbol(symbol);
  }

  private tick() {
    for (const [s, w] of this.windows) w.advance(this.nowEx(s));
    this.evaluateAll();
  }

  private evaluateAll() {
    for (const s of this.windows.keys()) this.evaluateSymbol(s);
  }

  /** 就绪 = 窗口已预热完；若 spec 用到 24h ticker，还须已收到第一条 ticker 快照 */
  private readyOf(r: Runner, w: SymbolWindows) {
    return w.ready(r.needMs) && (!r.needTicker || w.ticker24h !== null);
  }

  private evaluateSymbol(symbol: string) {
    const w = this.windows.get(symbol);
    if (!w) return;
    for (const r of this.runners.values()) {
      if (r.row.spec.market.symbol !== symbol) continue;
      try {
        const now = w.now;
        r.values = w.evaluate(r.row.spec.metrics);
        r.result = evaluateCondition(r.row.spec.condition, r.values);
        r.ready = this.readyOf(r, w);
        r.lastEvalLocal = Date.now();
        r.error = null;
        const tr = r.sm.step(now, r.ready, r.result.passed);
        if (tr.fire) this.fire(r, now);
        if (tr.from !== tr.to) this.emit('changed');
      } catch (e) {
        r.error = (e as Error).message;
      }
    }
  }

  private fire(r: Runner, ts: number) {
    const { spec } = r.row;
    const g = gauge(r.result!);
    const webhook = r.row.webhook_id ? this.db.getWebhook(r.row.webhook_id) : undefined;
    const ev: Omit<EventRow, 'id'> = {
      signal_id: r.row.id,
      signal_version: r.row.version,
      ts,
      local_ts: Date.now(),
      symbol: spec.market.symbol,
      snapshot: { ...r.values },
      condition: r.result,
      spec,
      delivery_status: webhook ? 'pending' : 'none',
    };
    const id = this.db.insertEvent(ev);
    r.lastEventTs = ts;
    this.emit('event', { id, ...ev });
    if (!webhook) return;
    const metrics: Record<string, number | null> = { ...r.values };
    if (g.kind === 'ratio' && !('ratio' in metrics)) metrics.ratio = g.value;
    const payload = {
      event: 'signal.triggered',
      event_id: id,
      signal: spec.name,
      signal_id: r.row.id,
      title: spec.title,
      exchange: spec.market.exchange,
      market: spec.market.product,
      symbol: spec.market.symbol,
      timestamp: ts,
      condition: describeCondition(spec.condition),
      metrics,
    };
    this.dispatcher
      .deliver(webhook, payload, id)
      .then((res) => this.db.setEventDelivery(id, res.ok ? 'success' : 'failed'))
      .catch((e) => {
        console.error('[webhook] dispatcher crashed', e);
        this.db.setEventDelivery(id, 'failed');
      })
      .finally(() => this.emit('changed'));
  }

  private sample() {
    const local = Date.now();
    const ts = Math.floor(local / 1000) * 1000;
    for (const [symbol, w] of this.windows) {
      const vals = w.evaluate(CATALOG);
      for (const m of CATALOG) this.record(symbol, m.name, ts, vals[m.name]);
    }
    for (const r of this.runners.values()) {
      if (!r.result) continue;
      this.record(r.row.spec.market.symbol, `signal:${r.row.id}`, ts, r.ready ? gauge(r.result).value : null);
    }
  }

  private record(symbol: string, metric: string, ts: number, value: number | null) {
    const key = `${symbol}|${metric}`;
    let s = this.series.get(key);
    if (!s) {
      s = new Series();
      this.series.set(key, s);
    }
    const v = value === null || !Number.isFinite(value) ? null : value;
    s.push(ts, v);
    this.pending.push({ symbol, metric, ts, value: v });
  }

  private flush() {
    const batch = this.pending;
    this.pending = [];
    try {
      this.db.insertPoints(batch);
    } catch (e) {
      console.error('[db] flush metric points failed', e);
    }
  }

  /** 时间序列：内存覆盖不到的部分回落到数据库 */
  seriesFor(symbol: string, metric: string, rangeMs: number): [number, number | null][] {
    const from = Date.now() - rangeMs;
    const mem = this.series.get(`${symbol}|${metric}`);
    const memFrom = mem?.oldest ?? Infinity;
    const out: [number, number | null][] = [];
    if (from < memFrom) {
      const step = rangeMs > 15 * 60_000 ? 5_000 : 1_000;
      for (const p of this.db.queryPoints(symbol, metric, from, Math.min(memFrom - 1, Date.now()), step)) out.push([p.ts, p.value]);
    }
    if (mem) out.push(...mem.since(from));
    return out;
  }

  snapshot(symbol: string, names: string[]): Record<string, MetricValue> {
    const w = this.windows.get(symbol);
    if (!w) return {};
    const defs = CATALOG.filter((m) => names.includes(m.name));
    // combine 依赖项需一并计算
    const vals = w.evaluate(CATALOG.filter((m) => defs.some((d) => d.name === m.name || (d.kind === 'combine' && (d.a === m.name || d.b === m.name)))));
    return Object.fromEntries(names.map((n) => [n, vals[n] ?? null]));
  }

  /** Create 页 Preview：用实时窗口对未保存的规格求值一次（不触发、不落库） */
  preview(spec: SignalSpec) {
    const w = this.windows.get(spec.market.symbol);
    if (!w) return { subscribed: false, ready: false, values: {}, result: null };
    const values = w.evaluate(spec.metrics);
    const ready = w.ready(requiredWindowMs(spec)) && (!requiresTicker(spec) || w.ticker24h !== null);
    return { subscribed: true, ready, values, result: evaluateCondition(spec.condition, values) };
  }

  status(id: number): RunnerStatus | null {
    const r = this.runners.get(id);
    if (!r) {
      const row = this.db.getSignal(id);
      if (!row) return null;
      return {
        id, name: row.spec.name, symbol: row.spec.market.symbol, enabled: row.enabled, state: 'DISABLED', ready: false,
        last_eval_local: null, last_event_ts: this.db.lastEventTs(id), values: {}, gauge: { value: null, threshold: null, kind: 'value' }, error: null,
      };
    }
    return {
      id,
      name: r.row.spec.name,
      symbol: r.row.spec.market.symbol,
      enabled: true,
      state: r.sm.state,
      ready: r.ready,
      last_eval_local: r.lastEvalLocal,
      last_event_ts: r.lastEventTs,
      values: r.values,
      gauge: r.result ? gauge(r.result) : { value: null, threshold: null, kind: 'value' },
      error: r.error,
    };
  }

  allStatus(): RunnerStatus[] {
    return this.db.listSignals().map((s) => this.status(s.id)!);
  }

  symbols() {
    return [...this.windows.entries()].map(([symbol, w]) => {
      const t = w.ticker24h;
      return {
        symbol,
        ready_60s: w.ready(60_000),
        buffer: w.bufferSize,
        last_trade: w.lastTrade,
        exchange_now: w.now,
        ticker_24h: t ? { last: t.last, high: t.high, low: t.low, change_pct: t.changePct, E: t.E } : null,
      };
    });
  }
}
