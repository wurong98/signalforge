import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { isLeaf } from '../../../src/shared/dsl.ts';
import { StateBadge } from '../components/bits.tsx';
import type { SignalRow } from '../lib.ts';
import { api, fmtAgo, fmtGauge, fmtThreshold, useLive, useNow } from '../lib.ts';

export function firstLeafOp(row: SignalRow) {
  let c = row.spec.condition;
  while (!isLeaf(c)) c = c.conditions[0];
  return c;
}

export function gaugeLabel(row: SignalRow) {
  const l = firstLeafOp(row);
  if ('metric' in l.right) return `${l.left.replace(/_notional|_\d+[smh]$/g, '')} / ${l.right.metric.replace(/_notional|_\d+[smh]$/g, '')}`;
  return l.left;
}

export function SignalsPage() {
  const { tick, eventSeq, skew } = useLive();
  const now = useNow();
  const nav = useNavigate();
  const [rows, setRows] = useState<SignalRow[] | null>(null);
  const load = useCallback(() => api<SignalRow[]>('/signals').then(setRows), []);
  useEffect(() => {
    load();
  }, [load, eventSeq]);

  const live = new Map(tick?.signals.map((s) => [s.id, s]));

  const act = async (id: number, action: string) => {
    if (action === 'delete') {
      if (!confirm('删除该 Signal？历史事件与 Webhook 日志会保留。')) return;
      await api(`/signals/${id}`, { method: 'DELETE' });
    } else {
      const r = await api<{ id?: number }>(`/signals/${id}/${action}`, { method: 'POST' });
      if (action === 'duplicate' && r.id) return nav(`/signals/${r.id}`);
    }
    load();
  };

  if (!rows) return <div className="page">Loading…</div>;
  return (
    <div className="page">
      <div className="page-head">
        <h1>Signals</h1>
        <Link to="/" className="button primary">+ New Signal</Link>
      </div>
      {rows.length === 0 && (
        <div className="empty">
          还没有 Signal。<Link to="/">用一句话创建第一个 →</Link>
        </div>
      )}
      <div className="cards">
        {rows.map((row) => {
          const rt = live.get(row.id) ?? row.runtime;
          const leaf = firstLeafOp(row);
          const hot = rt?.state === 'COOLDOWN';
          return (
            <div key={row.id} className={`card signal-card ${hot ? 'hot' : ''}`}>
              <div className="signal-card-head">
                <Link to={`/signals/${row.id}`} className="title">{row.spec.title}</Link>
                <span className="tag">{row.spec.market.symbol}</span>
              </div>
              <div className="gauge-row">
                <div>
                  <div className="label">{gaugeLabel(row)}</div>
                  <div className="big mono">{fmtGauge(rt?.gauge)}</div>
                </div>
                <div>
                  <div className="label">Trigger</div>
                  <div className="big mono muted">{fmtThreshold(rt?.gauge, leaf.operator)}</div>
                </div>
              </div>
              <div className="kv compact">
                <span>Status</span>
                <span>{rt && <StateBadge state={rt.state} error={rt.error} />}</span>
                <span>Last Trigger</span>
                <span>{fmtAgo(rt?.last_event_ts, now + skew)}</span>
              </div>
              <div className="row">
                <Link to={`/signals/${row.id}`} className="button">Open</Link>
                {row.enabled ? (
                  <button className="ghost" onClick={() => act(row.id, 'disable')}>Disable</button>
                ) : (
                  <button className="ghost" onClick={() => act(row.id, 'enable')}>Enable</button>
                )}
                <button className="ghost" onClick={() => act(row.id, 'duplicate')}>Duplicate</button>
                <button className="ghost danger" onClick={() => act(row.id, 'delete')}>Delete</button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
