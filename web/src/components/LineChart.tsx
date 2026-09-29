import { useMemo, useRef, useState } from 'react';
import { fmtNum, fmtTime } from '../lib.ts';

interface Props {
  points: [number, number | null][];
  threshold?: number | null;
  thresholdLabel?: string;
  unit?: string;
  height?: number;
  /** 当前值超过阈值时用强调色 */
  accent?: boolean;
}

const W = 800;
const PAD = { l: 64, r: 16, t: 12, b: 24 };

/** 轻量 SVG 折线图：null 值断开线段，支持阈值线与悬停读数 */
export function LineChart({ points, threshold, thresholdLabel = 'Trigger', unit = '', height = 220, accent }: Props) {
  const ref = useRef<SVGSVGElement>(null);
  const [hover, setHover] = useState<number | null>(null);
  const H = height;
  const geo = useMemo(() => {
    const vals = points.map((p) => p[1]).filter((v): v is number => v !== null && Number.isFinite(v));
    if (threshold !== null && threshold !== undefined) vals.push(threshold);
    if (!points.length || !vals.length) return null;
    let min = Math.min(...vals);
    let max = Math.max(...vals);
    // 倍数类指标是重尾分布（分母接近 0 时可达数百倍），按 P95 截顶，否则阈值线会被压扁
    if (unit === 'x') {
      const sorted = [...vals].sort((a, b) => a - b);
      const p95 = sorted[Math.floor(sorted.length * 0.95)] ?? max;
      max = Math.min(max, Math.max(p95 * 1.2, (threshold ?? 0) * 1.5));
      min = Math.max(0, min);
    }
    if (min === max) {
      min -= Math.abs(min) * 0.01 || 1;
      max += Math.abs(max) * 0.01 || 1;
    }
    const span = max - min;
    const nonNegative = min >= 0;
    min -= span * 0.08;
    max += span * 0.08;
    if (nonNegative) min = Math.max(0, min);
    const t0 = points[0][0];
    const t1 = Math.max(points[points.length - 1][0], t0 + 1);
    const x = (t: number) => PAD.l + ((t - t0) / (t1 - t0)) * (W - PAD.l - PAD.r);
    const y = (v: number) => PAD.t + (1 - (Math.min(Math.max(v, min), max) - min) / (max - min)) * (H - PAD.t - PAD.b);
    let d = '';
    let pen = false;
    for (const [t, v] of points) {
      if (v === null || !Number.isFinite(v)) {
        pen = false;
        continue;
      }
      d += `${pen ? 'L' : 'M'}${x(t).toFixed(1)},${y(v).toFixed(1)}`;
      pen = true;
    }
    const ticks = [0, 0.5, 1].map((f) => min + (max - min) * f);
    return { x, y, d, ticks, t0, t1 };
  }, [points, threshold, H, unit]);

  if (!geo) return <div className="chart-empty" style={{ height }}>等待数据…（窗口预热中或暂无成交）</div>;

  const onMove = (e: React.MouseEvent) => {
    const r = ref.current!.getBoundingClientRect();
    const px = ((e.clientX - r.left) / r.width) * W;
    const t = geo.t0 + ((px - PAD.l) / (W - PAD.l - PAD.r)) * (geo.t1 - geo.t0);
    let best = 0;
    for (let i = 0; i < points.length; i++) if (Math.abs(points[i][0] - t) < Math.abs(points[best][0] - t)) best = i;
    setHover(best);
  };
  const hp = hover !== null ? points[hover] : null;
  const fmt = (v: number) => (unit === 'x' ? fmtNum(v, 'x') : fmtNum(v, unit));

  return (
    <div className="chart">
      <svg ref={ref} viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" style={{ height }} onMouseMove={onMove} onMouseLeave={() => setHover(null)}>
        {geo.ticks.map((v, i) => (
          <g key={i}>
            <line x1={PAD.l} x2={W - PAD.r} y1={geo.y(v)} y2={geo.y(v)} className="grid" />
            <text x={PAD.l - 8} y={geo.y(v) + 4} className="axis" textAnchor="end">{fmt(v)}</text>
          </g>
        ))}
        <text x={PAD.l} y={H - 6} className="axis">{fmtTime(geo.t0, false)}</text>
        <text x={W - PAD.r} y={H - 6} className="axis" textAnchor="end">{fmtTime(geo.t1, false)}</text>
        {threshold !== null && threshold !== undefined && (
          <g>
            <line x1={PAD.l} x2={W - PAD.r} y1={geo.y(threshold)} y2={geo.y(threshold)} className="threshold" />
            <text x={W - PAD.r - 4} y={geo.y(threshold) - 6} className="threshold-label" textAnchor="end">{thresholdLabel} {fmt(threshold)}</text>
          </g>
        )}
        <path d={geo.d} className={accent ? 'line accent' : 'line'} vectorEffect="non-scaling-stroke" />
        {hp && hp[1] !== null && (
          <g>
            <line x1={geo.x(hp[0])} x2={geo.x(hp[0])} y1={PAD.t} y2={H - PAD.b} className="cursor" />
            <circle cx={geo.x(hp[0])} cy={geo.y(hp[1])} r={3.5} className="dot" />
          </g>
        )}
      </svg>
      {hp && (
        <div className="chart-readout">
          {fmtTime(hp[0], false)} · <b>{hp[1] === null ? '—' : fmt(hp[1])}</b>
        </div>
      )}
    </div>
  );
}
