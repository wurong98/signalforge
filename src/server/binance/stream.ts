/**
 * Binance 公共行情 WebSocket（PRD §4 §18 §20 §25）：现货与 U 本位永续合约各一条连接。
 * 使用 combined stream，动态 SUBSCRIBE/UNSUBSCRIBE；断线指数退避重连；
 * 30s 无消息视为假死并主动重连；原始事件保留在内存环形缓存供 Data Sources 页查看。
 *
 * 每个交易对同时订阅两条流：
 * - `<symbol>@aggTrade` 逐笔聚合成交，驱动本地滑动窗口指标（最长 5m）；
 * - `<symbol>@ticker` 交易所侧维护的 24h 滚动统计，用来表达 aggTrade 窗口无法覆盖的
 *   长时间跨度需求（24h 新低、24h 涨跌幅），无需本地预热。
 *
 * 对外一律使用"市场键"（现货 BTCUSDT，合约 BTCUSDT.P，见 dsl.ts marketKey）。
 * 合约 aggTrade / 24hrTicker 报文字段是现货的子集，解析逻辑通用。
 *
 * 合约连接另订阅全局流 `tradingSession`（/market 路由，每秒每个市场一条，标的休市也推）作保活：
 * 冷门合约（如节假日的 TradFi 永续）成交可能间隔 30s 以上，ticker 也只在有变化时推送，
 * 若连接上只有这类合约，会被假死检测判死、反复重连，每次重连都作废窗口，永远攒不满预热。
 * 顺带记录各 TradFi 标的市场的当前时段（仅供展示）：NO_TRADING 指标的休市，
 * 合约本身 7×24 照常交易（标的休市时指数价格固定在最后已知值），不能据此判断"无成交"。
 * 报文：{e:"CN_EquityUpdate",E,t:时段开始,T:时段结束,S:"REGULAR"|"NO_TRADING"|...}，
 * e 去掉 Update 后转大写即市场名（CN_EQUITY），与 exchangeInfo 的 underlyingType 一致。
 */
import { EventEmitter } from 'node:events';
import type { Product } from '../../shared/dsl.ts';
import { FUTURES_SUFFIX, parseMarketKey } from '../../shared/dsl.ts';
import type { Ticker, Trade } from '../engine/window.ts';

export const STREAMS = ['aggTrade', 'ticker'] as const;
export type StreamName = (typeof STREAMS)[number];
/** 合约连接的全局流（不按交易对），见顶部注释 */
export const SESSION_STREAM = 'tradingSession';

/** TradFi 标的市场当前交易时段 */
export interface MarketSession {
  /** EQUITY / CN_EQUITY / HK_EQUITY / KR_EQUITY / COMMODITY / FX */
  market: string;
  /** REGULAR / NO_TRADING；美股另有 PRE_MARKET / AFTER_MARKET / OVERNIGHT */
  type: string;
  start: number;
  end: number;
  /** 交易所事件时间 */
  E: number;
}

export interface StreamStats {
  stream: StreamName;
  symbol: string;
  status: 'connecting' | 'connected' | 'disconnected' | 'error';
  messages_total: number;
  malformed_total: number;
  /** 最近 60s 的消息数 */
  messages_per_min: number;
  last_message_local: number | null;
  /** 本地接收时间 - 交易所事件时间 E（最近值，ms） */
  latency_ms: number | null;
  last_error: string | null;
}

export interface HubStatus {
  product: Product;
  status: 'connecting' | 'connected' | 'disconnected';
  url: string;
  connected_since: number | null;
  reconnects: number;
  last_error: string | null;
  streams: StreamStats[];
  /** 仅合约连接：各 TradFi 市场当前时段（按市场名排序） */
  sessions?: MarketSession[];
}

const RAW_RING = 50;

interface StreamState {
  stats: StreamStats;
  recent: number[];
  raw: unknown[];
}

export declare interface BinanceHub {
  on(ev: 'trade', fn: (symbol: string, t: Trade, eventTime: number, recvLocal: number) => void): this;
  on(ev: 'ticker', fn: (symbol: string, t: Ticker, eventTime: number, recvLocal: number) => void): this;
  /**
   * 这些市场键的流从本地时间 at 起已生效：连接建立（URL 自带的流）或 SUBSCRIBE 得到确认。
   * 此后连接不断，没收到成交就是确实没有成交，窗口从这一刻起算预热。
   */
  on(ev: 'connected', fn: (symbols: string[], at: number) => void): this;
  /** symbols：这条连接上受影响的市场键（只作废这些窗口，另一市场不受影响） */
  on(ev: 'disconnected', fn: (reason: string, symbols: string[]) => void): this;
}

/** 24h ticker 报文 → 归一化快照；P 由百分数转为小数，与 DSL 百分比约定一致 */
function parseTicker(d: any): Ticker | null {
  if (d?.e !== '24hrTicker') return null;
  const last = Number(d.c);
  const high = Number(d.h);
  const low = Number(d.l);
  const change = Number(d.p);
  const pct = Number(d.P);
  const volume = Number(d.v);
  const quoteVolume = Number(d.q);
  if (![last, high, low, change, pct, volume, quoteVolume].every(Number.isFinite)) return null;
  if (!Number.isFinite(d.E)) return null;
  return { E: d.E, last, high, low, change, changePct: pct / 100, volume, quoteVolume };
}

/** tradingSession 报文 → 时段；e 形如 EquityUpdate / CN_EquityUpdate / FXUpdate */
export function parseSession(d: any): MarketSession | null {
  const m = /^([A-Za-z_]+)Update$/.exec(String(d?.e ?? ''));
  if (!m || typeof d.S !== 'string' || ![d.E, d.t, d.T].every(Number.isFinite)) return null;
  return { market: m[1].toUpperCase(), type: d.S, start: d.t, end: d.T, E: d.E };
}

export class BinanceHub extends EventEmitter {
  private ws: WebSocket | null = null;
  private symbols = new Set<string>();
  private streams = new Map<string, StreamState>();
  private status: HubStatus['status'] = 'disconnected';
  private connectedSince: number | null = null;
  private reconnects = 0;
  private backoffMs = 1000;
  private lastError: string | null = null;
  private lastMessageLocal = 0;
  private reqId = 1;
  private watchdog: NodeJS.Timeout | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private stopped = false;
  private sessions = new Map<string, MarketSession>();
  /** 未确认的 SUBSCRIBE：请求 id → 市场键 */
  private pendingSubs = new Map<number, string[]>();

  /** 交易所报文里的 symbol → 市场键 */
  private readonly suffix: string;
  private started = false;

  constructor(private baseUrl: string, readonly product: Product = 'spot') {
    super();
    this.suffix = product === 'futures' ? FUTURES_SUFFIX : '';
  }

  /** 流名用交易所原始 symbol（小写），不带市场后缀 */
  private key(symbol: string, stream: StreamName) {
    return `${parseMarketKey(symbol).symbol.toLowerCase()}@${stream}`;
  }

  private keysOf(symbol: string) {
    return STREAMS.map((s) => this.key(symbol, s));
  }

  start(symbols: string[]) {
    for (const s of symbols) this.addState(s);
    symbols.forEach((s) => this.symbols.add(s));
    this.started = true;
    this.connect();
    this.watchdog = setInterval(() => this.checkStall(), 5_000);
  }

  stop() {
    this.stopped = true;
    if (this.watchdog) clearInterval(this.watchdog);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.ws?.close();
  }

  private addState(symbol: string) {
    for (const stream of STREAMS) {
      const k = this.key(symbol, stream);
      if (this.streams.has(k)) continue;
      this.streams.set(k, {
        stats: {
          stream, symbol, status: 'connecting', messages_total: 0, malformed_total: 0,
          messages_per_min: 0, last_message_local: null, latency_ms: null, last_error: null,
        },
        recent: [],
        raw: [],
      });
    }
  }

  /** 确保某交易对已订阅（Signal 引用新交易对时调用） */
  ensure(symbol: string) {
    if (this.symbols.has(symbol)) return;
    this.symbols.add(symbol);
    this.addState(symbol);
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.subscribe([symbol]);
    } else if (this.started && !this.ws && !this.reconnectTimer) {
      // 空闲（无订阅未连接）时按需建立连接；等待重连时由 connect() 带上全部流，
      // 连接中（URL 已拼好）时由 onopen 补发 SUBSCRIBE
      this.connect();
    }
  }

  /** 生效以确认回执为准（onMessage 里发 connected），不能以发出请求为准 */
  private subscribe(symbols: string[]) {
    const id = this.reqId++;
    this.pendingSubs.set(id, symbols);
    this.ws!.send(JSON.stringify({ method: 'SUBSCRIBE', params: symbols.flatMap((s) => this.keysOf(s)), id }));
  }

  release(symbol: string) {
    if (!this.symbols.delete(symbol)) return;
    for (const k of this.keysOf(symbol)) this.streams.delete(k);
    if (!this.symbols.size) return this.idle();
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ method: 'UNSUBSCRIBE', params: this.keysOf(symbol), id: this.reqId++ }));
    }
  }

  /** 无订阅：断开且不重连（否则空连接收不到消息，会被假死检测反复重连） */
  private idle() {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    const ws = this.ws;
    this.ws = null;
    this.status = 'disconnected';
    this.connectedSince = null;
    try {
      ws?.close();
    } catch {}
  }

  private connect() {
    this.reconnectTimer = null;
    if (this.stopped || !this.symbols.size) return;
    const live = [...this.symbols];
    const streams = live.flatMap((s) => this.keysOf(s));
    if (this.product === 'futures') streams.push(SESSION_STREAM);
    const url = `${this.baseUrl}/stream?streams=${streams.join('/')}`;
    this.status = 'connecting';
    for (const s of this.streams.values()) s.stats.status = 'connecting';
    let ws: WebSocket;
    try {
      ws = new WebSocket(url);
    } catch (e) {
      this.onClose(`connect failed: ${(e as Error).message}`);
      return;
    }
    this.ws = ws;
    ws.onopen = () => {
      this.status = 'connected';
      this.connectedSince = Date.now();
      this.lastMessageLocal = Date.now();
      this.backoffMs = 1000;
      for (const s of this.streams.values()) s.stats.status = 'connected';
      // 只有 URL 里的流此刻生效；连接中途 ensure() 加进来的交易对不在 URL 里，要补订阅
      const inUrl = live.filter((s) => this.symbols.has(s));
      if (inUrl.length) this.emit('connected', inUrl, Date.now());
      const late = [...this.symbols].filter((s) => !live.includes(s));
      if (late.length) this.subscribe(late);
    };
    ws.onmessage = (ev) => this.onMessage(String(ev.data));
    ws.onerror = (ev: any) => {
      this.lastError = ev?.message ?? 'websocket error';
    };
    ws.onclose = (ev) => {
      if (this.ws === ws) this.onClose(`closed code=${ev.code}${ev.reason ? ` reason=${ev.reason}` : ''}`);
    };
  }

  private onClose(reason: string) {
    this.ws = null;
    this.pendingSubs.clear();
    this.status = 'disconnected';
    this.connectedSince = null;
    this.lastError = reason;
    for (const s of this.streams.values()) {
      s.stats.status = 'disconnected';
      s.stats.last_error = reason;
    }
    this.emit('disconnected', reason, [...this.symbols]);
    if (this.stopped) return;
    this.reconnects++;
    const delay = this.backoffMs;
    this.backoffMs = Math.min(this.backoffMs * 2, 30_000);
    console.warn(`[binance] ${reason}; reconnect in ${delay}ms`);
    this.reconnectTimer = setTimeout(() => this.connect(), delay);
  }

  private checkStall() {
    if (this.status === 'connected' && Date.now() - this.lastMessageLocal > 30_000) {
      console.warn('[binance] no message for 30s, forcing reconnect');
      const ws = this.ws;
      this.ws = null;
      try {
        ws?.close();
      } catch {}
      this.onClose('stalled: no message for 30s');
    }
  }

  private malformed(st: StreamState, reason: string, text: string) {
    st.stats.malformed_total++;
    st.stats.last_error = `${reason}: ${text.slice(0, 200)}`;
  }

  private onMessage(text: string) {
    const recv = Date.now();
    this.lastMessageLocal = recv;
    let msg: any;
    try {
      msg = JSON.parse(text);
    } catch {
      this.lastError = 'malformed JSON';
      return;
    }
    // 订阅请求响应：{"result":null,"id":1} 或错误
    if ('id' in msg && !('stream' in msg)) {
      const syms = this.pendingSubs.get(msg.id);
      this.pendingSubs.delete(msg.id);
      if (msg.error) {
        this.lastError = `subscription failed: ${JSON.stringify(msg.error)}`;
        console.warn(`[binance] ${this.lastError}`);
      } else if (syms) {
        // 确认前已被 release 的不算
        const live = syms.filter((s) => this.symbols.has(s));
        if (live.length) this.emit('connected', live, recv);
      }
      return;
    }
    if (msg.stream === SESSION_STREAM) {
      const s = parseSession(msg.data);
      if (s) this.sessions.set(s.market, s);
      else this.lastError = `malformed tradingSession: ${text.slice(0, 200)}`;
      return;
    }
    const st = this.streams.get(msg.stream);
    if (!st) return;
    const d = msg.data;

    // 先校验再计数：畸形报文不计入 messages_total，也不进原始事件环形缓存
    let payload: Trade | Ticker;
    if (st.stats.stream === 'ticker') {
      const t = parseTicker(d);
      if (!t) return this.malformed(st, 'malformed ticker event', text);
      payload = t;
    } else {
      const p = Number(d?.p);
      const q = Number(d?.q);
      if (d?.e !== 'aggTrade' || !Number.isFinite(p) || !Number.isFinite(q) || typeof d.m !== 'boolean' || !Number.isFinite(d.T)) {
        return this.malformed(st, 'malformed event', text);
      }
      payload = { a: d.a, T: d.T, p, q, m: d.m };
    }

    st.stats.messages_total++;
    st.stats.last_message_local = recv;
    st.stats.latency_ms = recv - d.E;
    st.recent.push(recv);
    st.raw.push(d);
    if (st.raw.length > RAW_RING) st.raw.shift();

    if (st.stats.stream === 'ticker') {
      this.emit('ticker', `${d.s}${this.suffix}`, payload as Ticker, d.E as number, recv);
    } else {
      this.emit('trade', `${d.s}${this.suffix}`, payload as Trade, d.E as number, recv);
    }
  }

  getStatus(): HubStatus {
    const now = Date.now();
    for (const s of this.streams.values()) {
      while (s.recent.length && s.recent[0] < now - 60_000) s.recent.shift();
      s.stats.messages_per_min = s.recent.length;
    }
    return {
      product: this.product,
      status: this.status,
      url: this.baseUrl,
      connected_since: this.connectedSince,
      reconnects: this.reconnects,
      last_error: this.lastError,
      streams: [...this.streams.values()].map((s) => ({ ...s.stats })),
      ...(this.product === 'futures' ? { sessions: [...this.sessions.values()].sort((a, b) => a.market.localeCompare(b.market)) } : {}),
    };
  }

  /** Data Sources 页用：`${symbol}@${stream}` → 最近的原始报文（最新在前） */
  samples(symbol: string, stream: StreamName = 'aggTrade'): unknown[] {
    return [...(this.streams.get(this.key(symbol, stream))?.raw ?? [])].reverse();
  }
}

export declare interface MarketHub {
  on(ev: 'trade', fn: (symbol: string, t: Trade, eventTime: number, recvLocal: number) => void): this;
  on(ev: 'ticker', fn: (symbol: string, t: Ticker, eventTime: number, recvLocal: number) => void): this;
  on(ev: 'connected', fn: (symbols: string[], at: number) => void): this;
  on(ev: 'disconnected', fn: (reason: string, symbols: string[]) => void): this;
}

/**
 * 现货 + 合约两条连接的组合，接口与单个 BinanceHub 相同：按市场键后缀路由，事件原样转发。
 * 两条连接独立重连；一条断线只作废该市场的窗口（disconnected 事件带受影响的市场键）。
 */
export class MarketHub extends EventEmitter {
  readonly hubs: Record<Product, BinanceHub>;

  constructor(spotUrl: string, futuresUrl: string) {
    super();
    this.hubs = { spot: new BinanceHub(spotUrl, 'spot'), futures: new BinanceHub(futuresUrl, 'futures') };
    for (const h of Object.values(this.hubs)) {
      for (const ev of ['trade', 'ticker', 'connected', 'disconnected']) (h as EventEmitter).on(ev, (...a: unknown[]) => this.emit(ev, ...a));
    }
  }

  private of(key: string) {
    return this.hubs[parseMarketKey(key).product];
  }

  start(keys: string[]) {
    for (const [p, h] of Object.entries(this.hubs)) h.start(keys.filter((k) => parseMarketKey(k).product === p));
  }
  stop() {
    for (const h of Object.values(this.hubs)) h.stop();
  }
  ensure(key: string) {
    this.of(key).ensure(key);
  }
  release(key: string) {
    this.of(key).release(key);
  }
  samples(key: string, stream: StreamName = 'aggTrade') {
    return this.of(key).samples(key, stream);
  }

  /** 顶层字段沿用现货连接（兼容旧页面），每个市场的连接状态见 connections */
  getStatus(): HubStatus & { connections: Omit<HubStatus, 'streams'>[] } {
    const all = Object.values(this.hubs).map((h) => h.getStatus());
    return {
      ...all[0],
      streams: all.flatMap((h) => h.streams),
      connections: all.map(({ streams: _s, ...rest }) => rest),
    };
  }
}
