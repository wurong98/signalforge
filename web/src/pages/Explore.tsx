import { useEffect, useMemo, useState } from 'react';
import { EXPLORE_DEFAULTS } from '../../../src/shared/catalog.ts';
import { WINDOW_SUFFIX_RE } from '../../../src/shared/dsl.ts';
import { LineChart } from '../components/LineChart.tsx';
import { api, fmtNum, useLive } from '../lib.ts';

interface CatalogItem {
  name: string;
  kind: string;
  window?: string;
  formula: string;
  unit: string;
  description: string;
}
const RANGES = ['1m', '5m', '15m', '1h'];

function loadSelection(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem('explore.metrics') ?? 'null');
    if (Array.isArray(v) && v.length) return v;
  } catch {}
  return EXPLORE_DEFAULTS;
}

export function ExplorePage() {
  const { tick } = useLive();
  const symbols = tick?.symbols.map((s) => s.symbol) ?? ['BTCUSDT'];
  const [symbol, setSymbol] = useState('BTCUSDT');
  const [catalog, setCatalog] = useState<CatalogItem[]>([]);
  const [selected, setSelected] = useState<string[]>(loadSelection);
  const [range, setRange] = useState('5m');
  const [data, setData] = useState<{ current: Record<string, number | null>; series: Record<string, [number, number | null][]> } | null>(null);

  useEffect(() => {
    api<CatalogItem[]>('/catalog').then(setCatalog);
  }, []);
  useEffect(() => {
    try {
      localStorage.setItem('explore.metrics', JSON.stringify(selected));
    } catch {}
    if (!selected.length) return setData(null);
    const f = () => api(`/metrics/series?symbol=${symbol}&metrics=${selected.join(',')}&range=${range}`).then(setData).catch(() => {});
    f();
    const t = setInterval(f, 2000);
    return () => clearInterval(t);
  }, [symbol, selected, range]);

  const groups = useMemo(() => {
    const g = new Map<string, CatalogItem[]>();
    for (const c of catalog) {
      const k = c.name.replace(WINDOW_SUFFIX_RE, '');
      g.set(k, [...(g.get(k) ?? []), c]);
    }
    return [...g.entries()];
  }, [catalog]);
  const byName = new Map(catalog.map((c) => [c.name, c]));
  const toggle = (n: string) => setSelected((s) => (s.includes(n) ? s.filter((x) => x !== n) : [...s, n]));

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Explore</h1>
          <p className="muted small">观察实时派生指标，判断一个 Signal 是否有意义。所有指标都可追溯到 Binance aggTrade 原始字段。</p>
        </div>
        <div className="row">
          <select value={symbol} onChange={(e) => setSymbol(e.target.value)}>
            {symbols.map((s) => (
              <option key={s}>{s}</option>
            ))}
          </select>
          <div className="seg">
            {RANGES.map((r) => (
              <button key={r} className={r === range ? 'on' : ''} onClick={() => setRange(r)}>{r}</button>
            ))}
          </div>
        </div>
      </div>

      <div className="card metric-picker">
        {groups.map(([base, items]) => (
          <div key={base} className="picker-row">
            <span className="picker-label">{base}</span>
            {items.map((c) => (
              <button key={c.name} className={`chip ${selected.includes(c.name) ? 'on' : ''}`} onClick={() => toggle(c.name)} title={c.formula}>
                {c.window ?? c.name.match(WINDOW_SUFFIX_RE)?.[1] ?? c.name}
              </button>
            ))}
            <span className="muted small">{items[0].description}</span>
          </div>
        ))}
      </div>

      <div className="charts">
        {selected.map((n) => {
          const c = byName.get(n);
          const unit = c?.unit ?? '';
          return (
            <div key={n} className="card">
              <div className="chart-head">
                <code>{n}</code>
                <span className="big mono">{fmtNum(data?.current[n], unit)}</span>
              </div>
              <LineChart points={data?.series[n] ?? []} unit={unit} height={160} />
              {c && <pre className="formula small">{c.formula}</pre>}
            </div>
          );
        })}
      </div>
    </div>
  );
}
