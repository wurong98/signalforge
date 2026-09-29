import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import type { SignalSpec } from '../../../src/shared/dsl.ts';
import { metricUnit } from '../../../src/shared/dsl.ts';
import { LineChart } from '../components/LineChart.tsx';
import { ExplainPanel, Section, SpecView, StateBadge } from '../components/bits.tsx';
import type { Delivery, EventRow, SignalRow } from '../lib.ts';
import {
  ApiError, api, binanceChartUrl, fmtAgo, fmtGauge, fmtNum, fmtThreshold, fmtTime, tradingViewUrl, useLive, useNow,
} from '../lib.ts';
import { firstLeafOp, gaugeLabel } from './Signals.tsx';

type Detail = SignalRow & { webhook: { id: number; name: string; url: string } | null };
const RANGES = ['1m', '5m', '15m', '1h'];

export function SignalDetailPage() {
  const id = Number(useParams().id);
  const nav = useNavigate();
  const { tick, eventSeq, skew } = useLive();
  const now = useNow(250) + skew;
  const [row, setRow] = useState<Detail | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [range, setRange] = useState('5m');
  const [points, setPoints] = useState<[number, number | null][]>([]);
  const [events, setEvents] = useState<EventRow[]>([]);
  const [selected, setSelected] = useState<(EventRow & { deliveries: Delivery[] }) | null>(null);
  const [editing, setEditing] = useState(false);
  const [specText, setSpecText] = useState('');
  const [errors, setErrors] = useState<string[]>([]);

  const load = useCallback(() => {
    api<Detail>(`/signals/${id}`).then(setRow).catch(() => setNotFound(true));
    api<EventRow[]>(`/events?signal_id=${id}&limit=30`).then(setEvents);
  }, [id]);
  useEffect(load, [load, eventSeq]);

  useEffect(() => {
    const f = () => api<{ points: [number, number | null][] }>(`/signals/${id}/series?range=${range}`).then((r) => setPoints(r.points));
    f();
    const t = setInterval(f, 2000);
    return () => clearInterval(t);
  }, [id, range]);

  const openEvent = async (eid: number) => setSelected(await api(`/events/${eid}`));
  // 选中事件的投递可能仍在重试，定时刷新
  useEffect(() => {
    if (!selected || selected.delivery_status !== 'pending') return;
    const t = setTimeout(() => openEvent(selected.id), 1500);
    return () => clearTimeout(t);
  }, [selected]);

  if (notFound) return <div className="page">Signal 不存在。<Link to="/signals">返回</Link></div>;
  if (!row) return <div className="page">Loading…</div>;

  const rt = tick?.signals.find((s) => s.id === id) ?? row.runtime;
  const leaf = firstLeafOp(row);
  const leftDef = row.spec.metrics.find((m) => m.name === leaf.left);
  const unit = rt?.gauge.kind === 'ratio' ? 'x' : leftDef ? metricUnit(leftDef, row.spec.metrics) : '';
  const streamLatency = tick?.binance.streams.find((s) => s.symbol === row.spec.market.symbol);

  const saveSpec = async () => {
    setErrors([]);
    try {
      const spec = JSON.parse(specText) as SignalSpec;
      await api(`/signals/${id}`, { method: 'PUT', body: { spec, webhook_id: row.webhook_id } });
      setEditing(false);
      load();
    } catch (e) {
      setErrors(e instanceof ApiError ? e.errors : [String(e)]);
    }
  };

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <Link to="/signals" className="muted small">← Signals</Link>
          <h1>{row.spec.title}</h1>
          <div className="row">
            {rt && <StateBadge state={rt.state} error={rt.error} />}
            <span className="muted small">
              Last Event {streamLatency?.last_message_local ? fmtAgo(streamLatency.last_message_local, now) : '—'} · Last Evaluation{' '}
              {fmtAgo(rt?.last_eval_local, now)}
            </span>
          </div>
        </div>
        <div className="row">
          <a className="button ghost" href={binanceChartUrl(row.spec.market.symbol)} target="_blank" rel="noreferrer">Open Binance Chart ↗</a>
          <a className="button ghost" href={tradingViewUrl(row.spec.market.symbol)} target="_blank" rel="noreferrer">Open TradingView ↗</a>
        </div>
      </div>

      {rt?.error && <div className="alert bad">Signal error: {rt.error}</div>}

      <div className="detail-grid">
        <div className="card">
          <div className="gauge-row">
            <div>
              <div className="label">Current · {gaugeLabel(row)}</div>
              <div className="huge mono">{fmtGauge(rt?.gauge, unit)}</div>
            </div>
            <div>
              <div className="label">Trigger</div>
              <div className="huge mono muted">{fmtThreshold(rt?.gauge, leaf.operator, unit)}</div>
            </div>
            <div className="seg">
              {RANGES.map((r) => (
                <button key={r} className={r === range ? 'on' : ''} onClick={() => setRange(r)}>{r}</button>
              ))}
            </div>
          </div>
          <LineChart points={points} threshold={rt?.gauge.threshold} unit={unit} accent={rt?.state === 'COOLDOWN'} />
          <div className="muted small">曲线为第一个条件的主值（倍数或左侧指标），每秒采样；阈值线即触发线。</div>
        </div>

        <div className="card">
          <Section label="Recent Events" right={<span className="muted small">{events.length}</span>}>
            {events.length === 0 && <div className="muted small">尚未触发</div>}
            <div className="events">
              {events.map((e) => {
                const l0 = e.condition.leaves[0];
                return (
                  <button key={e.id} className={`event ${selected?.id === e.id ? 'on' : ''}`} onClick={() => openEvent(e.id)}>
                    <span className="mono">{fmtTime(e.ts)}</span>
                    <span>Triggered</span>
                    <span className="mono muted">{l0?.ratio != null ? `${l0.ratio.toFixed(2)}x` : fmtNum(l0?.left)}</span>
                    <span className={`dot-status ${e.delivery_status}`}>{e.delivery_status === 'none' ? '' : e.delivery_status}</span>
                  </button>
                );
              })}
            </div>
          </Section>
        </div>
      </div>

      {selected && (
        <div className="card">
          <div className="row end">
            <button className="ghost" onClick={() => setSelected(null)}>Close</button>
          </div>
          <ExplainPanel event={selected} deliveries={selected.deliveries} />
        </div>
      )}

      <div className="card">
        <div className="page-head">
          <h2>Configuration</h2>
          <div className="row">
            <span className="muted small">v{row.version}</span>
            {!editing && (
              <button className="ghost" onClick={() => (setSpecText(JSON.stringify(row.spec, null, 2)), setEditing(true))}>Edit</button>
            )}
            <button
              className="ghost danger"
              onClick={async () => {
                if (!confirm('删除该 Signal？历史事件会保留。')) return;
                await api(`/signals/${id}`, { method: 'DELETE' });
                nav('/signals');
              }}
            >
              Delete
            </button>
          </div>
        </div>
        {errors.length > 0 && <div className="alert bad">{errors.map((e, i) => <div key={i}>{e}</div>)}</div>}
        {editing ? (
          <>
            <textarea className="json" rows={22} value={specText} onChange={(e) => setSpecText(e.target.value)} />
            <div className="row">
              <button className="primary" onClick={saveSpec}>Save (new version)</button>
              <button className="ghost" onClick={() => setEditing(false)}>Cancel</button>
            </div>
          </>
        ) : (
          <SpecView
            spec={row.spec}
            values={rt?.values}
            action={
              row.webhook ? (
                <div className="mono">
                  Webhook → <Link to="/webhooks">{row.webhook.name}</Link> <span className="muted">{row.webhook.url}</span>
                </div>
              ) : (
                <div className="muted">未绑定 Webhook（仅记录事件）</div>
              )
            }
          />
        )}
        {row.source_text && <p className="muted small">原始描述：{row.source_text}</p>}
      </div>
    </div>
  );
}
