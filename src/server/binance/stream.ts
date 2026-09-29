/**
 * Binance Spot 公共行情 WebSocket（PRD §4 §18 §20 §25）。
 * 使用 combined stream，动态 SUBSCRIBE/UNSUBSCRIBE；断线指数退避重连；
 * 30s 无消息视为假死并主动重连；原始事件保留在内存环形缓存供 Data Sources 页查看。
 */
import { EventEmitter } from 'node:events';
import type { Trade } from '../engine/window.ts';

export interface StreamStats {
  stream: string;
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
  on(ev: 'connected', fn: (symbols: string[], at: number) => void): this;
  on(ev: 'disconnected', fn: (reason: string) => void): this;
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

  private key(symbol: string) {
    return `${symbol.toLowerCase()}@aggTrade`;
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
    const k = this.key(symbol);
    if (this.streams.has(k)) return;
    this.streams.set(k, {
      stats: {
        stream: 'aggTrade', symbol, status: 'connecting', messages_total: 0, malformed_total: 0,
        messages_per_min: 0, last_message_local: null, latency_ms: null, last_error: null,
      },
      recent: [],
      raw: [],
    });
  }

  /** 确保某交易对已订阅（Signal 引用新交易对时调用） */
  ensure(symbol: string) {
    if (this.symbols.has(symbol)) return;
    this.symbols.add(symbol);
    this.addState(symbol);
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ method: 'SUBSCRIBE', params: [this.key(symbol)], id: this.reqId++ }));
    }
  }

  release(symbol: string) {
    if (!this.symbols.delete(symbol)) return;
    this.streams.delete(this.key(symbol));
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ method: 'UNSUBSCRIBE', params: [this.key(symbol)], id: this.reqId++ }));
    }
  }

  private connect() {
    if (this.stopped) return;
    const streams = [...this.symbols].map((s) => this.key(s));
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
    const p = Number(d?.p);
    const q = Number(d?.q);
    if (d?.e !== 'aggTrade' || !Number.isFinite(p) || !Number.isFinite(q) || typeof d.m !== 'boolean' || !Number.isFinite(d.T)) {
      st.stats.malformed_total++;
      st.stats.last_error = `malformed event: ${text.slice(0, 200)}`;
      return;
    }
    st.stats.messages_total++;
    st.stats.last_message_local = recv;
    st.stats.latency_ms = recv - d.E;
    st.recent.push(recv);
    st.raw.push(d);
    if (st.raw.length > RAW_RING) st.raw.shift();
    this.emit('trade', d.s as string, { a: d.a, T: d.T, p, q, m: d.m }, d.E as number, recv);
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

  samples(symbol: string): unknown[] {
    return [...(this.streams.get(this.key(symbol))?.raw ?? [])].reverse();
  }
}
