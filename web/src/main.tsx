import { type FormEvent, StrictMode, useCallback, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, NavLink, Route, Routes } from 'react-router-dom';
import { type ServerBuild, checkBuilds, formatBuild } from '../../src/shared/build.ts';
import { LiveContext, UNAUTHORIZED_EVENT, WEB_BUILD, api, fmtAgo, fmtDateTime, useLive, useLiveSource, useNow } from './lib.ts';
import { AssistantPage } from './pages/Assistant.tsx';
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

/** 页面底部版本：确认服务器上跑的是哪个 commit，前端构建与服务进程不一致时标红 */
function BuildFooter() {
  const [server, setServer] = useState<ServerBuild | null>(null);
  useEffect(() => {
    api<ServerBuild>('/version').then(setServer).catch(() => {});
  }, []);
  const check = server ? checkBuilds(WEB_BUILD, server) : { level: 'ok' as const };
  return (
    <footer className="build-footer mono">
      <span>{formatBuild(server ?? WEB_BUILD)}</span>
      {server && <span>启动于 {fmtDateTime(server.started_at).slice(0, 16)}</span>}
      <span>构建于 {fmtDateTime(WEB_BUILD.built_at).slice(0, 16)}</span>
      {check.level !== 'ok' && <span className={check.level === 'bad' ? 'bad-text' : 'warn-text'}>⚠ {check.message}</span>}
    </footer>
  );
}

/** 首次打开设置管理密码 / 之后输入管理密码；未通过前不渲染任何业务页面，也不建立 SSE */
function AuthScreen({ configured, onDone }: { configured: boolean; onDone: () => void }) {
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!configured && password !== confirm) return setError('两次输入的密码不一致');
    setBusy(true);
    setError('');
    try {
      await api(configured ? '/auth/login' : '/auth/setup', { body: { password } });
      onDone();
    } catch (err) {
      setError((err as Error).message);
      // 别人抢先完成了设置：切到登录
      if (!configured) onDone();
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="auth-wrap">
      <form className="card auth-card" onSubmit={submit}>
        <div className="big">{configured ? '输入管理密码' : '设置管理密码'}</div>
        <div className="muted small">
          {configured
            ? '忘记密码：删除服务器上的 data/admin.json（ADMIN_FILE）后刷新页面即可重新设置。'
            : '首次使用，请设置管理密码（至少 8 位）。之后所有访问都需要输入它。'}
        </div>
        <label>
          密码
          <input type="password" autoFocus autoComplete={configured ? 'current-password' : 'new-password'} value={password} onChange={(e) => setPassword(e.target.value)} />
        </label>
        {!configured && (
          <label>
            确认密码
            <input type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} />
          </label>
        )}
        {error && <div className="alert bad">{error}</div>}
        <button className="primary" disabled={busy || !password}>{configured ? '登录' : '设置并进入'}</button>
      </form>
    </div>
  );
}

function AuthGate() {
  const [auth, setAuth] = useState<{ configured: boolean; authenticated: boolean } | null>(null);
  const refresh = useCallback(() => {
    api<{ configured: boolean; authenticated: boolean }>('/auth/status')
      .then(setAuth)
      .catch(() => setAuth({ configured: true, authenticated: false }));
  }, []);
  useEffect(() => {
    refresh();
    window.addEventListener(UNAUTHORIZED_EVENT, refresh);
    return () => window.removeEventListener(UNAUTHORIZED_EVENT, refresh);
  }, [refresh]);
  if (!auth) return null;
  if (!auth.authenticated) return <AuthScreen configured={auth.configured} onDone={refresh} />;
  const logout = () => api('/auth/logout', { body: {} }).finally(refresh);
  return <App onLogout={logout} />;
}

function App({ onLogout }: { onLogout: () => void }) {
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
            <NavLink to="/assistant">Assistant</NavLink>
            <NavLink to="/signals">Signals</NavLink>
            <NavLink to="/explore">Explore</NavLink>
            <NavLink to="/webhooks">Webhooks</NavLink>
            <span className="nav-sep" />
            <NavLink to="/data-sources" className="secondary">Data Sources</NavLink>
          </nav>
          <LiveStatus />
          <button className="ghost small logout" onClick={onLogout}>退出</button>
        </header>
        <main>
          <Routes>
            <Route path="/" element={<CreatePage />} />
            <Route path="/assistant" element={<AssistantPage />} />
            <Route path="/signals" element={<SignalsPage />} />
            <Route path="/signals/:id" element={<SignalDetailPage />} />
            <Route path="/explore" element={<ExplorePage />} />
            <Route path="/webhooks" element={<WebhooksPage />} />
            <Route path="/data-sources" element={<DataSourcesPage />} />
          </Routes>
        </main>
        <BuildFooter />
      </BrowserRouter>
    </LiveContext.Provider>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <AuthGate />
  </StrictMode>,
);
