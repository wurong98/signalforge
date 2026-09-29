import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, NavLink, Route, Routes } from 'react-router-dom';
import { LiveContext, fmtAgo, useLive, useLiveSource, useNow } from './lib.ts';
import { CreatePage } from './pages/Create.tsx';
import { DataSourcesPage } from './pages/DataSources.tsx';
import { ExplorePage } from './pages/Explore.tsx';
import { SignalDetailPage } from './pages/SignalDetail.tsx';
import { SignalsPage } from './pages/Signals.tsx';
import { WebhooksPage } from './pages/Webhooks.tsx';
import './styles.css';

/** 顶部实时状态：让用户始终知道系统是否在真实运行（PRD §24） */
function LiveStatus() {
  const { tick, connected } = useLive();
  const now = useNow(500);
  if (!connected || !tick) return <div className="live bad">● Server disconnected</div>;
  const b = tick.binance;
  const stream = b.streams[0];
  const lastMsg = stream?.last_message_local ? now + (tick.server_time - Date.now()) - stream.last_message_local : null;
  const stale = lastMsg === null || lastMsg > 5_000;
  return (
    <div className="live">
      <span className={b.status === 'connected' ? 'ok-text' : 'bad-text'}>● Binance {b.status === 'connected' ? 'Connected' : b.status}</span>
      <span className="muted">Latency</span>
      <span className="mono">{stream?.latency_ms ?? '—'}ms</span>
      {tick.symbols.map((s) => (
        <span key={s.symbol} className={stale ? 'warn-text' : 'ok-text'}>
          {s.symbol} {stale ? `stale · ${fmtAgo(stream?.last_message_local)}` : 'Live'}
        </span>
      ))}
    </div>
  );
}

function App() {
  const live = useLiveSource();
  return (
    <LiveContext.Provider value={live}>
      <BrowserRouter>
        <header className="top">
          <NavLink to="/" className="brand">
            <svg viewBox="0 0 32 32" width="22" height="22" aria-hidden>
              <path d="M2 20 L10 20 L14 8 L18 26 L22 14 L30 14" fill="none" stroke="currentColor" strokeWidth="3" />
            </svg>
            Signal Studio
          </NavLink>
          <nav>
            <NavLink to="/" end>Create</NavLink>
            <NavLink to="/signals">Signals</NavLink>
            <NavLink to="/explore">Explore</NavLink>
            <NavLink to="/webhooks">Webhooks</NavLink>
            <span className="nav-sep" />
            <NavLink to="/data-sources" className="secondary">Data Sources</NavLink>
          </nav>
          <LiveStatus />
        </header>
        <main>
          <Routes>
            <Route path="/" element={<CreatePage />} />
            <Route path="/signals" element={<SignalsPage />} />
            <Route path="/signals/:id" element={<SignalDetailPage />} />
            <Route path="/explore" element={<ExplorePage />} />
            <Route path="/webhooks" element={<WebhooksPage />} />
            <Route path="/data-sources" element={<DataSourcesPage />} />
          </Routes>
        </main>
      </BrowserRouter>
    </LiveContext.Provider>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
