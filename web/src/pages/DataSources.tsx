import { useEffect, useMemo, useState } from 'react';
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
      {(b?.connections ?? (b ? [{ ...b, product: 'spot' as const }] : [])).map((c) => {
        // 合约连接按需建立：没有合约 Signal 时不连接，显示为空闲而不是故障
        const idle = !b?.streams.some((s) => s.symbol.endsWith('.P') === (c.product === 'futures'));
        return (
          <div key={c.product} className="card">
            <h2>{c.product === 'futures' ? 'USDⓈ-M Perpetual' : 'Spot'}</h2>
            <div className="kv">
              <span>Endpoint</span>
              <code>{c.url}/stream</code>
              <span>Connection</span>
              {idle ? (
                <span className="muted">○ idle（{c.product === 'futures' ? '无合约 Signal，不连接' : '无订阅'}）</span>
              ) : (
                <span className={c.status === 'connected' ? 'ok-text' : 'bad-text'}>● {c.status}</span>
              )}
              <span>Connected since</span>
              <span>{c.connected_since ? fmtAgo(c.connected_since, now + skew) : '—'}</span>
              <span>Reconnects</span>
              <span className="mono">{c.reconnects}</span>
              <span>Last error</span>
              <span className="small">{c.last_error ?? '—'}</span>
            </div>
          </div>
        );
      })}
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
      <AllSymbols />
    </div>
  );
}

interface MarketSymbolRow {
  symbol: string; base: string; quote: string; product: 'spot' | 'futures'; key: string; contract?: string; subscribed: boolean;
}

const MARKETS = [
  ['spot', '现货'],
  ['futures', 'U 本位永续'],
  ['all', '全部市场'],
] as const;

/** 全部可监控交易对（现货 + U 本位永续，exchangeInfo TRADING）：可搜索、按市场 / 计价币筛选，任何一个都能建 Signal */
function AllSymbols() {
  const [rows, setRows] = useState<MarketSymbolRow[] | null>(null);
  const [errs, setErrs] = useState<Record<string, string>>({});
  const [err, setErr] = useState<string | null>(null);
  const [q, setQ] = useState('');
  const [market, setMarket] = useState<string>('spot');
  const [quote, setQuote] = useState('USDT');
  useEffect(() => {
    api<{ symbols: MarketSymbolRow[]; errors?: Record<string, string> }>('/binance/symbols')
      .then((r) => {
        setRows(r.symbols.sort((a, b) => a.key.localeCompare(b.key)));
        setErrs(r.errors ?? {});
      })
      .catch((e) => setErr((e as Error).message));
  }, []);
  const inMarket = useMemo(() => (rows ?? []).filter((r) => market === 'all' || r.product === market), [rows, market]);
  const quotes = useMemo(() => {
    const m = new Map<string, number>();
    for (const r of inMarket) m.set(r.quote, (m.get(r.quote) ?? 0) + 1);
    return [...m].sort((a, b) => b[1] - a[1]);
  }, [inMarket]);
  const query = q.trim().toUpperCase();
  const shown = inMarket.filter((r) => (quote === 'ALL' || r.quote === quote) && (!query || r.key.includes(query)));
  // 筛选条件挡住了搜索结果时（如 ANTHROPICUSDT 只有合约、筛选停在现货），提示别处的匹配，避免误以为不存在
  const elsewhere = query && !shown.length ? (rows ?? []).filter((r) => r.key.includes(query)) : [];

  return (
    <div className="card">
      <div className="page-head">
        <h2>All Binance pairs</h2>
        <span className="muted small">{rows ? `${shown.length} / ${rows.length}` : err ? '' : '加载中…'}</span>
      </div>
      <p className="muted small">
        当前可交易（TRADING）的全部现货与 U 本位永续合约（含美股等 TradFi 永续），任意一个都可建 Signal（建好后自动订阅）。
        币安里现货与合约符号写法相同，这里合约加 <code>.P</code> 区分（同 TradingView）。● 为已订阅。
      </p>
      {err && <p className="bad-text small">{err}</p>}
      {Object.entries(errs).map(([k, v]) => <p key={k} className="bad-text small">{k === 'futures' ? '合约' : '现货'}列表获取失败：{v}</p>)}
      {rows && (
        <>
          <div className="row">
            <input placeholder="搜索，如 PEPE / AI / QQQ" value={q} onChange={(e) => setQ(e.target.value)} />
            <select value={market} onChange={(e) => setMarket(e.target.value)}>
              {MARKETS.map(([k, label]) => <option key={k} value={k}>{label}</option>)}
            </select>
            <select value={quote} onChange={(e) => setQuote(e.target.value)}>
              <option value="ALL">全部计价币 ({inMarket.length})</option>
              {quotes.map(([k, n]) => <option key={k} value={k}>{k} ({n})</option>)}
            </select>
          </div>
          <div className="symbol-grid mono small">
            {shown.map((r) => (
              <span key={r.key} className={r.subscribed ? 'ok-text' : undefined} title={r.contract === 'TRADIFI_PERPETUAL' ? `${r.key}（TradFi 永续）` : r.key}>
                {r.subscribed ? '● ' : ''}{r.key}{r.contract === 'TRADIFI_PERPETUAL' ? ' ·TradFi' : ''}
              </span>
            ))}
            {!shown.length && <span className="muted">无匹配</span>}
          </div>
          {elsewhere.length > 0 && (
            <p className="small">
              当前筛选外有 {elsewhere.length} 个匹配：
              <span className="mono">{elsewhere.slice(0, 5).map((r) => r.key).join('、')}{elsewhere.length > 5 ? ' …' : ''}</span>{' '}
              <button className="ghost small" onClick={() => { setMarket('all'); setQuote('ALL'); }}>在全部市场中显示</button>
            </p>
          )}
        </>
      )}
    </div>
  );
}
