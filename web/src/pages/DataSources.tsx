import { useEffect, useState } from 'react';
import type { StreamStats } from '../lib.ts';
import { api, fmtAgo, useLive, useNow } from '../lib.ts';

/** 两条流的字段表不同：aggTrade 是逐笔成交，ticker 是 24h 滚动统计 */
const AGGTRADE_FIELDS: Record<string, string> = {
  e: 'Event type', E: 'Event time', s: 'Symbol', a: 'Aggregate trade ID', p: 'Price', q: 'Quantity',
  f: 'First trade ID', l: 'Last trade ID', T: 'Trade time', m: 'Buyer is maker', M: 'Ignore',
};

const TICKER_FIELDS: Record<string, string> = {
  e: 'Event type', E: 'Event time', s: 'Symbol', p: 'Price change', P: 'Price change percent', w: 'Weighted avg price',
  x: 'Previous close', c: 'Current close', Q: 'Close quote volume', b: 'Best bid', B: 'Best bid qty',
  a: 'Best ask', A: 'Best ask qty', o: 'Open', h: '24h high', l: '24h low', v: 'Base volume', q: 'Quote volume',
  O: 'Stats open time', C: 'Stats close time', F: 'First trade ID', L: 'Last trade ID', n: 'Number of trades',
};

export function DataSourcesPage() {
  const { tick } = useLive();
  const now = useNow(250);
  const [samples, setSamples] = useState<Record<string, unknown[]>>({});
  useEffect(() => {
    const f = () => api<{ samples: Record<string, unknown[]> }>('/datasources').then((r) => setSamples(r.samples));
    f();
    const t = setInterval(f, 3000);
    return () => clearInterval(t);
  }, []);
  const b = tick?.binance;
  const skew = tick ? tick.server_time - Date.now() : 0;

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Data Sources</h1>
          <p className="muted small">系统实际订阅的 Binance 公共行情流。无需 API Key。</p>
        </div>
      </div>
      <div className="card">
        <div className="kv">
          <span>Endpoint</span>
          <code>{b?.url}/stream</code>
          <span>Connection</span>
          <span className={b?.status === 'connected' ? 'ok-text' : 'bad-text'}>● {b?.status ?? '—'}</span>
          <span>Connected since</span>
          <span>{b?.connected_since ? fmtAgo(b.connected_since, now + skew) : '—'}</span>
          <span>Reconnects</span>
          <span className="mono">{b?.reconnects ?? 0}</span>
          <span>Last error</span>
          <span className="small">{b?.last_error ?? '—'}</span>
        </div>
      </div>
      {b?.streams.map((s: StreamStats) => {
        const fields = s.stream === 'ticker' ? TICKER_FIELDS : AGGTRADE_FIELDS;
        const sample = samples[`${s.symbol}@${s.stream}`]?.[0];
        return (
        <div key={`${s.symbol}@${s.stream}`} className="card">
          <div className="page-head">
            <h2>
              {s.symbol} <span className="muted">@</span> {s.stream}
            </h2>
            <span className={s.status === 'connected' ? 'badge ok' : 'badge bad'}>● {s.status}</span>
          </div>
          <div className="stats">
            <div><div className="label">Messages</div><div className="big mono">{s.messages_per_min.toLocaleString()}/min</div></div>
            <div><div className="label">Last Message</div><div className="big mono">{s.last_message_local ? fmtAgo(s.last_message_local, now + skew) : '—'}</div></div>
            <div><div className="label">Latency (recv − E)</div><div className="big mono">{s.latency_ms ?? '—'}ms</div></div>
            <div><div className="label">Total</div><div className="big mono">{s.messages_total.toLocaleString()}</div></div>
            <div><div className="label">Malformed</div><div className={`big mono ${s.malformed_total ? 'bad-text' : ''}`}>{s.malformed_total}</div></div>
          </div>
          <h4>Sample Raw Event</h4>
          <div className="raw">
            <pre className="formula">{sample ? JSON.stringify(sample, null, 2) : '—'}</pre>
            <div className="kv small">
              {Object.entries(fields).flatMap(([k, v]) => [<code key={k}>{k}</code>, <span key={`${k}v`}>{v}</span>])}
            </div>
          </div>
        </div>
        );
      })}
    </div>
  );
}
