/**
 * Binance Spot 公共行情 WebSocket（PRD §4 §18 §20 §25）。
 * 使用 combined stream，动态 SUBSCRIBE/UNSUBSCRIBE；断线指数退避重连；
 * 30s 无消息视为假死并主动重连；原始事件保留在内存环形缓存供 Data Sources 页查看。
 *
 * 每个交易对同时订阅两条流：
 * - `<symbol>@aggTrade` 逐笔聚合成交，驱动本地滑动窗口指标（最长 60s）；
 * - `<symbol>@ticker` 交易所侧维护的 24h 滚动统计，用来表达 aggTrade 窗口无法覆盖的
 *   长时间跨度需求（24h 新低、24h 涨跌幅），无需本地预热。
 */
import { EventEmitter } from 'node:events';
import type { Ticker, Trade } from '../engine/window.ts';

export const STREAMS = ['aggTrade', 'ticker'] as const;
export type StreamName = (typeof STREAMS)[number];

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
  status: 'connecting' | 'connected' | 'disconnected';
  url: string;
  connected_since: number | null;
  reconnects: number;
  last_error: string | null;
  streams: StreamStats[];
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
  on(ev: 'connected', fn: (symbols: string[], at: number) => void): this;
  on(ev: 'disconnected', fn: (reason: string) => void): this;
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

  constructor(private baseUrl: string) {
    super();
  }

  private key(symbol: string, stream: StreamName) {
    return `${symbol.toLowerCase()}@${stream}`;
  }

  private keysOf(symbol: string) {
    return STREAMS.map((s) => this.key(symbol, s));
  }

  start(symbols: string[]) {
    for (const s of symbols) this.addState(s);
    symbols.forEach((s) => this.symbols.add(s));
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
      this.ws.send(JSON.stringify({ method: 'SUBSCRIBE', params: this.keysOf(symbol), id: this.reqId++ }));
    }
  }

  release(symbol: string) {
    if (!this.symbols.delete(symbol)) return;
    for (const k of this.keysOf(symbol)) this.streams.delete(k);
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ method: 'UNSUBSCRIBE', params: this.keysOf(symbol), id: this.reqId++ }));
    }
  }

  private connect() {
    if (this.stopped) return;
    const streams = [...this.symbols].flatMap((s) => this.keysOf(s));
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
      this.emit('connected', [...this.symbols], Date.now());
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
    this.status = 'disconnected';
    this.connectedSince = null;
    this.lastError = reason;
    for (const s of this.streams.values()) {
      s.stats.status = 'disconnected';
      s.stats.last_error = reason;
    }
    this.emit('disconnected', reason);
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
      if (msg.error) {
        this.lastError = `subscription failed: ${JSON.stringify(msg.error)}`;
        console.warn(`[binance] ${this.lastError}`);
      }
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
      this.emit('ticker', d.s as string, payload as Ticker, d.E as number, recv);
    } else {
      this.emit('trade', d.s as string, payload as Trade, d.E as number, recv);
    }
  }

  getStatus(): HubStatus {
    const now = Date.now();
    for (const s of this.streams.values()) {
      while (s.recent.length && s.recent[0] < now - 60_000) s.recent.shift();
      s.stats.messages_per_min = s.recent.length;
    }
    return {
      status: this.status,
      url: this.baseUrl,
      connected_since: this.connectedSince,
      reconnects: this.reconnects,
      last_error: this.lastError,
      streams: [...this.streams.values()].map((s) => ({ ...s.stats })),
    };
  }

  /** Data Sources 页用：`${symbol}@${stream}` → 最近的原始报文（最新在前） */
  samples(symbol: string, stream: StreamName = 'aggTrade'): unknown[] {
    return [...(this.streams.get(this.key(symbol, stream))?.raw ?? [])].reverse();
  }
}
