import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { DeliveryLine } from '../components/bits.tsx';
import type { Delivery } from '../lib.ts';
import { ApiError, api, fmtAgo, useLive, useNow } from '../lib.ts';
import { isFeishuWebhook } from '../../../src/shared/webhook.ts';

interface Hook {
  id: number;
  name: string;
  url: string;
  method: string;
  headers: Record<string, string>;
  secret: string;
  timeout_ms: number;
  max_retries: number;
  stats: { success: number | null; failed: number | null; avg_latency_ms: number | null; last_ts: number | null; last_error: string | null };
  signals: { id: number; title: string }[];
}

const EMPTY = { name: '', url: '', method: 'POST', headers: '{}', secret: '', timeout_ms: 5000, max_retries: 3 };

export function WebhooksPage() {
  const { eventSeq } = useLive();
  const now = useNow();
  const [hooks, setHooks] = useState<Hook[]>([]);
  const [form, setForm] = useState<typeof EMPTY & { id?: number }>(EMPTY);
  const [showForm, setShowForm] = useState(false);
  const [errors, setErrors] = useState<string[]>([]);
  const [open, setOpen] = useState<number | null>(null);
  const [log, setLog] = useState<Delivery[]>([]);
  const [testResult, setTestResult] = useState<Record<number, string>>({});

  const load = useCallback(() => api<Hook[]>('/webhooks').then(setHooks), []);
  useEffect(() => {
    load();
  }, [load, eventSeq]);
  useEffect(() => {
    if (open === null) return;
    const f = () => api<Delivery[]>(`/webhooks/${open}/deliveries`).then(setLog);
    f();
    const t = setInterval(f, 3000);
    return () => clearInterval(t);
  }, [open, eventSeq]);

  const save = async () => {
    setErrors([]);
    try {
      let headers: Record<string, string>;
      try {
        headers = JSON.parse(form.headers || '{}');
      } catch {
        return setErrors(['Headers 必须是 JSON 对象，例如 {"Authorization": "Bearer xxx"}']);
      }
      const body = { ...form, headers, timeout_ms: Number(form.timeout_ms), max_retries: Number(form.max_retries), name: form.name || (form.url && new URL(form.url).host) };
      delete (body as any).id;
      if (form.id) await api(`/webhooks/${form.id}`, { method: 'PUT', body });
      else await api('/webhooks', { body });
      setShowForm(false);
      setForm(EMPTY);
      load();
    } catch (e) {
      setErrors(e instanceof ApiError ? e.errors : [String(e)]);
    }
  };

  const test = async (id: number) => {
    setTestResult((r) => ({ ...r, [id]: 'Sending…' }));
    const r = await api<{ ok: boolean; http_status: number | null; latency_ms: number | null; error: string | null }>(`/webhooks/${id}/test`, { method: 'POST' });
    setTestResult((x) => ({ ...x, [id]: r.ok ? `✓ ${r.http_status} · ${r.latency_ms}ms` : `✗ ${r.error}` }));
    load();
    if (open === id) api<Delivery[]>(`/webhooks/${id}/deliveries`).then(setLog);
  };

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Webhooks</h1>
          <p className="muted small">
            POST application/json · 失败按 1s / 5s / 30s 重试 · 配置 Secret 后带 <code>X-SignalForge-Signature: sha256=HMAC(secret, timestamp.body)</code>
          </p>
        </div>
        <button className="primary" onClick={() => (setForm(EMPTY), setShowForm(true))}>+ New Webhook</button>
      </div>

      {showForm && (
        <div className="card form">
          <h2>{form.id ? 'Edit Webhook' : 'New Webhook'}</h2>
          {errors.length > 0 && <div className="alert bad">{errors.map((e, i) => <div key={i}>{e}</div>)}</div>}
          <label>URL<input value={form.url} onChange={(e) => setForm({ ...form, url: e.target.value })} placeholder="https://example.com/webhook" /></label>
          {isFeishuWebhook(form.url) && (
            <div className="muted small">
              已识别为飞书机器人：以消息卡片发送，并按响应体 code 判定成败。机器人开启"签名校验"时把密钥填入 Secret；
              开启"自定义关键词"时，把关键词设为 SignalForge（每张卡片脚注都带）。
            </div>
          )}
          <label>Name<input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="默认使用域名" /></label>
          <div className="row">
            <label>Method
              <select value={form.method} onChange={(e) => setForm({ ...form, method: e.target.value })}>
                <option>POST</option>
                <option>PUT</option>
              </select>
            </label>
            <label>Timeout (ms)<input type="number" value={form.timeout_ms} onChange={(e) => setForm({ ...form, timeout_ms: Number(e.target.value) })} /></label>
            <label>Max retries<input type="number" min={0} max={3} value={form.max_retries} onChange={(e) => setForm({ ...form, max_retries: Number(e.target.value) })} /></label>
          </div>
          <label>Secret<input value={form.secret} onChange={(e) => setForm({ ...form, secret: e.target.value })} placeholder={isFeishuWebhook(form.url) ? '飞书签名校验密钥（可选）' : '可选'} /></label>
          <label>Headers (JSON)<textarea rows={3} className="json" value={form.headers} onChange={(e) => setForm({ ...form, headers: e.target.value })} /></label>
          <div className="row">
            <button className="primary" onClick={save}>Save</button>
            <button className="ghost" onClick={() => setShowForm(false)}>Cancel</button>
          </div>
        </div>
      )}

      {hooks.length === 0 && !showForm && <div className="empty">还没有 Webhook。可以在创建 Signal 时直接填写 URL。</div>}

      {hooks.map((h) => {
        const total = (h.stats.success ?? 0) + (h.stats.failed ?? 0);
        return (
          <div key={h.id} className="card">
            <div className="page-head">
              <div>
                <h2>{h.name}</h2>
                <code className="muted">{h.method} {h.url}</code>
              </div>
              <div className="row">
                {testResult[h.id] && <span className="small mono">{testResult[h.id]}</span>}
                <button onClick={() => test(h.id)}>Test Webhook</button>
                <button
                  className="ghost"
                  onClick={() => {
                    setForm({ id: h.id, name: h.name, url: h.url, method: h.method, headers: JSON.stringify(h.headers), secret: h.secret, timeout_ms: h.timeout_ms, max_retries: h.max_retries });
                    setShowForm(true);
                  }}
                >
                  Edit
                </button>
                <button
                  className="ghost danger"
                  onClick={async () => {
                    if (!confirm('删除该 Webhook？绑定它的 Signal 将只记录事件。')) return;
                    await api(`/webhooks/${h.id}`, { method: 'DELETE' });
                    load();
                  }}
                >
                  Delete
                </button>
              </div>
            </div>
            <div className="stats">
              <div><div className="label">Success</div><div className="big mono ok-text">{h.stats.success ?? 0}</div></div>
              <div><div className="label">Failed</div><div className={`big mono ${h.stats.failed ? 'bad-text' : ''}`}>{h.stats.failed ?? 0}</div></div>
              <div><div className="label">Success rate</div><div className="big mono">{total ? `${(((h.stats.success ?? 0) / total) * 100).toFixed(1)}%` : '—'}</div></div>
              <div><div className="label">Avg latency</div><div className="big mono">{h.stats.avg_latency_ms !== null ? `${Math.round(h.stats.avg_latency_ms)}ms` : '—'}</div></div>
              <div><div className="label">Last delivery</div><div className="big mono">{fmtAgo(h.stats.last_ts, now)}</div></div>
            </div>
            {h.stats.last_error && <div className="alert bad small">Last Error: {h.stats.last_error}</div>}
            <div className="muted small">
              Used by:{' '}
              {h.signals.length ? h.signals.map((s, i) => <span key={s.id}>{i > 0 && ', '}<Link to={`/signals/${s.id}`}>{s.title}</Link></span>) : '—'}
            </div>
            <button className="ghost small" onClick={() => setOpen(open === h.id ? null : h.id)}>{open === h.id ? 'Hide log' : 'Show delivery log'}</button>
            {open === h.id && (
              <div className="log">
                <div className="delivery head"><span>Time</span><span>Attempt</span><span>HTTP</span><span>Latency</span><span className="grow">Result</span></div>
                {log.map((d) => <DeliveryLine key={d.id} d={d} />)}
                {log.length === 0 && <div className="muted small">暂无记录</div>}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
