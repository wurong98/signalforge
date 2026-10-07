import { createContext, useContext, useEffect, useState } from 'react';
import type { WebBuild } from '../../src/shared/build.ts';
import type { SignalSpec } from '../../src/shared/dsl.ts';
import { parseMarketKey } from '../../src/shared/dsl.ts';

/** vite 构建时写入（vite.config.ts 的 define） */
declare const __WEB_BUILD__: WebBuild;
export const WEB_BUILD = __WEB_BUILD__;

// ---------- API ----------
export class ApiError extends Error {
  constructor(public errors: string[]) {
    super(errors.join('\n'));
  }
}

export const UNAUTHORIZED_EVENT = 'sf:unauthorized';

export async function api<T = any>(path: string, init?: { method?: string; body?: unknown }): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method: init?.method ?? (init?.body !== undefined ? 'POST' : 'GET'),
    headers: init?.body !== undefined ? { 'content-type': 'application/json' } : undefined,
    body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  // 会话失效（过期 / 密码文件被删除重设）：通知 AuthGate 回到登录框
  if (res.status === 401 && !path.startsWith('/auth/')) window.dispatchEvent(new Event(UNAUTHORIZED_EVENT));
  if (!res.ok) throw new ApiError(data.errors ?? [`HTTP ${res.status}`]);
  return data;
}

// ---------- 类型（与服务端返回结构对应） ----------
export type SignalState = 'WARMING' | 'ARMED' | 'COOLDOWN' | 'ACTIVE' | 'DISABLED';
export interface Gauge {
  value: number | null;
  threshold: number | null;
  kind: 'ratio' | 'value';
}
export interface RunnerStatus {
  id: number;
  name: string;
  symbol: string;
  enabled: boolean;
  state: SignalState;
  ready: boolean;
  last_eval_local: number | null;
  last_event_ts: number | null;
  values: Record<string, number | null>;
  gauge: Gauge;
  error: string | null;
}
export interface StreamStats {
  stream: 'aggTrade' | 'ticker';
  symbol: string;
  status: string;
  messages_total: number;
  malformed_total: number;
  messages_per_min: number;
  last_message_local: number | null;
  latency_ms: number | null;
  last_error: string | null;
}
export interface LiveTick {
  server_time: number;
  binance: {
    status: string; url: string; connected_since: number | null; reconnects: number; last_error: string | null; streams: StreamStats[];
    /** 每个市场一条连接（现货 / U 本位永续） */
    connections?: { product: 'spot' | 'futures'; status: string; url: string; connected_since: number | null; reconnects: number; last_error: string | null }[];
  };
  symbols: {
    symbol: string;
    ready_60s: boolean;
    buffer: number;
    exchange_now: number;
    last_trade: { p: number; T: number } | null;
    ticker_24h: { last: number; high: number; low: number; change_pct: number; E: number } | null;
  }[];
  llm: { enabled: boolean; model?: string };
  signals: RunnerStatus[];
}
export interface SignalRow {
  id: number;
  spec: SignalSpec;
  webhook_id: number | null;
  enabled: boolean;
  version: number;
  source_text: string;
  created_at: number;
  runtime?: RunnerStatus;
}
export interface LeafResult {
  expr: string;
  left_metric: string;
  left: number | null;
  operator: string;
  right_expr: string;
  right: number | null;
  ratio?: number | null;
  multiplier?: number;
  passed: boolean;
}
export interface EventRow {
  id: number;
  signal_id: number;
  signal_version: number;
  ts: number;
  local_ts: number;
  symbol: string;
  snapshot: Record<string, number | null>;
  condition: { passed: boolean; complete: boolean; leaves: LeafResult[] };
  spec: SignalSpec;
  delivery_status: 'pending' | 'success' | 'failed' | 'none';
}
export interface Delivery {
  id: number;
  event_id: number | null;
  webhook_id: number;
  attempt: number;
  ts: number;
  ok: boolean;
  http_status: number | null;
  latency_ms: number | null;
  error: string | null;
  is_test: boolean;
}

// ---------- 实时状态（SSE） ----------
export interface LiveState {
  tick: LiveTick | null;
  /** 浏览器与服务端 SSE 是否连通 */
  connected: boolean;
  /** 本地收到最近一条事件推送的计数，用于触发列表刷新 */
  eventSeq: number;
  /** 服务端时间 - 浏览器时间 */
  skew: number;
}
export const LiveContext = createContext<LiveState>({ tick: null, connected: false, eventSeq: 0, skew: 0 });
export const useLive = () => useContext(LiveContext);

export function useLiveSource(): LiveState {
  const [state, setState] = useState<LiveState>({ tick: null, connected: false, eventSeq: 0, skew: 0 });
  useEffect(() => {
    const es = new EventSource('/api/live');
    es.addEventListener('tick', (e) => {
      const tick = JSON.parse((e as MessageEvent).data) as LiveTick;
      setState((s) => ({ ...s, tick, connected: true, skew: tick.server_time - Date.now() }));
    });
    es.addEventListener('signal_event', () => setState((s) => ({ ...s, eventSeq: s.eventSeq + 1 })));
    es.onerror = () => {
      setState((s) => ({ ...s, connected: false }));
      // 401 等非 200 响应会让 EventSource 永久关闭而不重连，此时确认一下是否是会话失效
      if (es.readyState === EventSource.CLOSED)
        api<{ authenticated: boolean }>('/auth/status')
          .then((r) => !r.authenticated && window.dispatchEvent(new Event(UNAUTHORIZED_EVENT)))
          .catch(() => {});
    };
    return () => es.close();
  }, []);
  return state;
}

/** 每 interval 毫秒重渲染一次，用于"x 秒前"之类的相对时间 */
export function useNow(interval = 1000) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), interval);
    return () => clearInterval(t);
  }, [interval]);
  return now;
}

// ---------- 格式化 ----------
export function fmtNum(v: number | null | undefined, unit = ''): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—';
  if (unit === '%') return `${(v * 100).toFixed(3)}%`;
  if (unit === 'x') return `${v.toFixed(2)}x`;
  const a = Math.abs(v);
  const s =
    a >= 1e9 ? `${(v / 1e9).toFixed(2)}B` : a >= 1e6 ? `${(v / 1e6).toFixed(2)}M` : a >= 1e4 ? `${(v / 1e3).toFixed(1)}K` : a >= 100 ? v.toFixed(2) : a >= 1 ? v.toFixed(3) : v.toPrecision(3);
  return unit === 'USDT' ? `$${s}` : unit === 'trades' ? s : s;
}

export function fmtAgo(ts: number | null | undefined, now = Date.now()): string {
  if (!ts) return 'never';
  const d = Math.max(0, now - ts);
  if (d < 1000) return `${d}ms ago`;
  if (d < 60_000) return `${Math.floor(d / 1000)}s ago`;
  if (d < 3_600_000) return `${Math.floor(d / 60_000)} min ago`;
  if (d < 86_400_000) return `${Math.floor(d / 3_600_000)} h ago`;
  return `${Math.floor(d / 86_400_000)} d ago`;
}

export function fmtTime(ts: number, ms = true): string {
  const d = new Date(ts);
  const p = (n: number, l = 2) => String(n).padStart(l, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}${ms ? `.${p(d.getMilliseconds(), 3)}` : ''}`;
}

export function fmtDateTime(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${fmtTime(ts)}`;
}

export function fmtGauge(g: Gauge | undefined, unit = ''): string {
  if (!g) return '—';
  return g.kind === 'ratio' ? fmtNum(g.value, 'x') : fmtNum(g.value, unit);
}

export function fmtThreshold(g: Gauge | undefined, op: string, unit = ''): string {
  if (!g || g.threshold === null) return '—';
  return `${op} ${g.kind === 'ratio' ? fmtNum(g.threshold, 'x') : fmtNum(g.threshold, unit)}`;
}

/** 参数为市场键：现货 BTCUSDT，U 本位永续 BTCUSDT.P */
export const binanceChartUrl = (key: string) => {
  const { product, symbol } = parseMarketKey(key);
  if (product === 'futures') return `https://www.binance.com/en/futures/${symbol}`;
  const quote = ['USDT', 'USDC', 'FDUSD', 'BTC'].find((q) => symbol.endsWith(q)) ?? 'USDT';
  return `https://www.binance.com/en/trade/${symbol.slice(0, -quote.length)}_${quote}?type=spot`;
};
// TradingView 的永续写法正好也是 .P 后缀，市场键可直接用
export const tradingViewUrl = (key: string) => `https://www.tradingview.com/chart/?symbol=BINANCE:${key}`;
