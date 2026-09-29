import type { ReactNode } from 'react';
import type { MetricDef, SignalSpec } from '../../../src/shared/dsl.ts';
import { describeCondition, describeFormula, metricUnit } from '../../../src/shared/dsl.ts';
import type { Delivery, EventRow, SignalState } from '../lib.ts';
import { fmtDateTime, fmtNum, fmtTime } from '../lib.ts';

const STATE_TEXT: Record<SignalState, string> = {
  ARMED: 'Running · Armed',
  ACTIVE: 'Running · Condition holding',
  COOLDOWN: 'Running · Cooldown',
  WARMING: 'Warming up',
  DISABLED: 'Disabled',
};

export function StateBadge({ state, error }: { state: SignalState; error?: string | null }) {
  if (error) return <span className="badge bad">● Error</span>;
  const cls = state === 'DISABLED' ? 'muted' : state === 'WARMING' ? 'warn' : state === 'COOLDOWN' ? 'hot' : 'ok';
  return <span className={`badge ${cls}`}>● {STATE_TEXT[state]}</span>;
}

export function Section({ label, children, right }: { label: string; children: ReactNode; right?: ReactNode }) {
  return (
    <section className="section">
      <div className="section-head">
        <span className="label">{label}</span>
        {right}
      </div>
      {children}
    </section>
  );
}

export function MetricLine({ m, all, value, symbol }: { m: MetricDef; all: MetricDef[]; value?: number | null; symbol: string }) {
  return (
    <details className="metric-line">
      <summary>
        <code>{m.name}</code>
        {value !== undefined && <span className="metric-value">{fmtNum(value, metricUnit(m, all))}</span>}
        <span className="muted small">{m.kind === 'window' ? `${m.window} · ${m.aggregation}` : m.op}</span>
      </summary>
      <pre className="formula">{describeFormula(m)}{m.kind === 'window' ? `\n\nSource  ${symbol} @ ${m.stream}` : ''}</pre>
    </details>
  );
}

/** Create / Detail 共用的结构化展示：SOURCE / METRICS / CONDITION / ACTION */
export function SpecView({ spec, values, action }: { spec: SignalSpec; values?: Record<string, number | null>; action?: ReactNode }) {
  const streams = [...new Set(spec.metrics.flatMap((m) => (m.kind === 'window' ? [m.stream] : [])))];
  return (
    <div className="spec-grid">
      <Section label="Source">
        <div className="mono">
          Binance / Spot / <b>{spec.market.symbol}</b> / {streams.join(', ')}
        </div>
      </Section>
      <Section label="Metrics">
        {spec.metrics.map((m) => (
          <MetricLine key={m.name} m={m} all={spec.metrics} value={values?.[m.name]} symbol={spec.market.symbol} />
        ))}
      </Section>
      <Section label="Condition">
        <div className="mono condition">{describeCondition(spec.condition)}</div>
        <div className="muted small">Cooldown {spec.cooldown_ms / 1000}s · 只在"未满足 → 满足"时触发</div>
      </Section>
      <Section label="Action">{action ?? <div className="mono">Webhook</div>}</Section>
    </div>
  );
}

export function DeliveryLine({ d }: { d: Delivery }) {
  return (
    <div className={`delivery ${d.ok ? 'ok' : 'bad'}`}>
      <span className="mono">{fmtTime(d.ts)}</span>
      <span>#{d.attempt}</span>
      <span className="mono">{d.http_status ?? '—'}</span>
      <span className="mono">{d.latency_ms !== null ? `${d.latency_ms}ms` : '—'}</span>
      <span className="grow small">{d.ok ? 'OK' : d.error}</span>
      {d.is_test && <span className="tag">test</span>}
    </div>
  );
}

/** Explain（PRD §12）：完全基于触发时刻保存的确定性快照 */
export function ExplainPanel({ event, deliveries }: { event: EventRow; deliveries: Delivery[] }) {
  const { spec } = event;
  const unitOf = (name: string) => {
    const m = spec.metrics.find((x) => x.name === name);
    return m ? metricUnit(m, spec.metrics) : '';
  };
  const windows = [...new Set(spec.metrics.flatMap((m) => (m.kind === 'window' ? [m.window] : [])))];
  return (
    <div className="explain">
      <h3>Why did this trigger?</h3>
      <p className="muted small">
        {spec.condition && 'op' in spec.condition ? `以下条件以 ${spec.condition.op.toUpperCase()} 组合，` : ''}
        在 {fmtDateTime(event.ts)} 由"未满足"变为"满足"。数值为触发瞬间的快照（Signal v{event.signal_version}）。
      </p>
      {event.condition.leaves.map((l, i) => (
        <div key={i} className={`leaf ${l.passed ? 'pass' : 'fail'}`}>
          <div className="mono leaf-expr">{l.passed ? '✓' : '✗'} {l.expr}</div>
          <div className="leaf-vals">
            <span>
              <code>{l.left_metric}</code> = <b>{fmtNum(l.left, unitOf(l.left_metric))}</b>
            </span>
            <span>
              <code>{l.right_expr}</code> = <b>{fmtNum(l.right, unitOf(l.left_metric))}</b>
            </span>
            {l.multiplier !== undefined && (
              <span>
                ratio = <b>{l.ratio === null || l.ratio === undefined ? (l.left && l.left > 0 ? '∞ (分母为 0)' : '—') : l.ratio.toFixed(2)}</b>
                <span className="muted"> · required {l.operator} {l.multiplier}</span>
              </span>
            )}
          </div>
        </div>
      ))}
      <div className="kv">
        <span>Source</span>
        <span className="mono">{event.symbol} @ aggTrade</span>
        <span>Window</span>
        <span className="mono">{windows.join(', ')}</span>
        <span>Trigger Time</span>
        <span className="mono">{fmtTime(event.ts)} (exchange) · recorded {fmtTime(event.local_ts)}</span>
      </div>
      <h4>Metric snapshot</h4>
      <div className="kv">
        {Object.entries(event.snapshot).flatMap(([k, v]) => [
          <code key={k}>{k}</code>,
          <span key={`${k}v`} className="mono">{fmtNum(v, unitOf(k))}</span>,
        ])}
      </div>
      <h4>Webhook</h4>
      {event.delivery_status === 'none' ? (
        <p className="muted small">未绑定 Webhook</p>
      ) : deliveries.length ? (
        deliveries.map((d) => <DeliveryLine key={d.id} d={d} />)
      ) : (
        <p className="muted small">投递中…</p>
      )}
    </div>
  );
}
