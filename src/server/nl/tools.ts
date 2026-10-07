/**
 * 助手只读工具（docs/llm-assistant-plan.md §3）。
 * - 只调用 Runtime / Db 的只读方法，不写库、不启停 Signal（AGENTS.md 不变量 11）；
 * - 输出按字段白名单构造，不含 webhook url / headers / secret；
 * - 返回统计结果而非原始点列，控制 token；
 * - null 原样返回（窗口预热中 / 无成交），绝不补 0（不变量 4）；
 * - 收益率 / 24h 涨跌幅等小数在这里统一换成百分数，避免 LLM 换算出错。
 */
import { z } from 'zod';
import { CATALOG, CATALOG_BY_NAME } from '../../shared/catalog.ts';
import { SYMBOL_RE, describeCondition, describeFormula, metricUnit } from '../../shared/dsl.ts';
import type { Db } from '../db.ts';
import type { Runtime } from '../engine/runtime.ts';
import type { LlmTool } from './llm.ts';

export interface ToolDeps {
  runtime: Pick<Runtime, 'symbols' | 'snapshot' | 'status'>;
  db: Pick<Db, 'listSignals' | 'getSignal' | 'eventCounts' | 'eventTimestamps' | 'listEventsBetween' | 'failedDeliveriesBetween' | 'metricStats'>;
  /** 指标历史保留天数（METRIC_RETENTION_DAYS）；更早的区间直接拒答 */
  retentionDays: number;
  now: () => number;
  /** 用户时区（IANA），输出时间按它格式化 */
  tz: string;
}

const DAY = 86_400_000;

export function safeTz(tz: string | undefined): string {
  try {
    if (tz) {
      new Intl.DateTimeFormat('en', { timeZone: tz });
      return tz;
    }
  } catch {}
  return 'UTC';
}

/** "2026-10-07 14:32:05"（用户时区） */
export function fmtTime(ts: number | null | undefined, tz: string): string | null {
  if (ts === null || ts === undefined) return null;
  return new Intl.DateTimeFormat('sv-SE', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).format(ts);
}

const sig = (x: number | null | undefined) => (x === null || x === undefined || !Number.isFinite(x) ? null : Number(x.toPrecision(6)));

/** 指标值 → 对外展示值：小数百分比换成百分数 */
function present(name: string, v: number | null | undefined): { value: number | null; unit: string } {
  const def = CATALOG_BY_NAME.get(name);
  const unit = def ? metricUnit(def, CATALOG) : '';
  if (unit === '%') return { value: sig(v === null || v === undefined ? null : v * 100), unit: '%' };
  return { value: sig(v), unit };
}

// ---------- 参数 schema ----------

const SymbolArg = z.string().trim().toUpperCase().regex(SYMBOL_RE).describe('Binance spot symbol, e.g. BTCUSDT');
const MetricName = z.string().describe('Catalog metric name, e.g. buy_notional_10s, return_5m, ticker_change_pct_24h');
const Range = {
  lookback_minutes: z.number().int().min(1).max(366 * 1440).optional().describe('Look back N minutes from now. Use this OR from/to.'),
  from: z.string().optional().describe('ISO 8601 start time WITH timezone offset, e.g. 2026-10-06T20:00:00+08:00'),
  to: z.string().optional().describe('ISO 8601 end time with offset; default now'),
};
const RangeSchema = z.object(Range);

type ToolResult = Record<string, unknown>;
class ToolError extends Error {
  constructor(public payload: ToolResult) {
    super(String(payload.error));
  }
}

function resolveRange(a: z.infer<typeof RangeSchema>, now: number): { from: number; to: number } {
  if (a.lookback_minutes !== undefined) return { from: now - a.lookback_minutes * 60_000, to: now };
  if (!a.from) throw new ToolError({ error: 'bad_args', message: 'give lookback_minutes, or from (and optionally to)' });
  const from = Date.parse(a.from);
  const to = a.to ? Date.parse(a.to) : now;
  if (!Number.isFinite(from) || !Number.isFinite(to)) throw new ToolError({ error: 'bad_args', message: 'from/to must be ISO 8601 with offset' });
  if (to <= from) throw new ToolError({ error: 'bad_args', message: 'to must be after from' });
  return { from, to: Math.min(to, now) };
}

function requireSubscribed(deps: ToolDeps, symbol: string) {
  const subscribed = deps.runtime.symbols().map((s) => s.symbol);
  if (!subscribed.includes(symbol)) {
    throw new ToolError({
      error: 'not_subscribed',
      symbol,
      subscribed,
      message: `${symbol} is not subscribed, so no real-time or historical metrics exist for it. Tell the user; they can create a Signal on it or add it to SYMBOLS.`,
    });
  }
}

function requireMetrics(names: string[]) {
  const bad = names.filter((n) => !CATALOG_BY_NAME.has(n));
  if (bad.length) throw new ToolError({ error: 'unknown_metric', unknown: bad, valid: CATALOG.map((m) => m.name) });
}

// ---------- 工具定义 ----------

interface ToolDef<S extends z.ZodObject> {
  name: string;
  description: string;
  schema: S;
  run: (args: z.infer<S>, deps: ToolDeps) => ToolResult;
}
const def = <S extends z.ZodObject>(t: ToolDef<S>) => t as unknown as ToolDef<z.ZodObject>;

const SNAPSHOT_DEFAULT = [
  'last_price', 'return_60s', 'return_5m', 'buy_notional_60s', 'sell_notional_60s', 'volume_delta_60s', 'buy_sell_ratio_60s',
  'trade_count_60s', 'ticker_change_pct_24h', 'ticker_high_24h', 'ticker_low_24h', 'ticker_quote_volume_24h',
];

export const TOOLS = [
  def({
    name: 'list_symbols',
    description: 'Subscribed symbols with readiness, last trade and 24h ticker. Only these symbols have metrics.',
    schema: z.object({}),
    run: (_a, d) => ({
      symbols: d.runtime.symbols().map((s) => ({
        symbol: s.symbol,
        window_ready_60s: s.ready_60s,
        last_trade: s.last_trade ? { price: sig(s.last_trade.p), time: fmtTime(s.last_trade.T, d.tz) } : null,
        ticker_24h: s.ticker_24h
          ? {
              last: sig(s.ticker_24h.last), high: sig(s.ticker_24h.high), low: sig(s.ticker_24h.low),
              change_pct: sig(s.ticker_24h.change_pct * 100), updated: fmtTime(s.ticker_24h.E, d.tz),
            }
          : null,
      })),
    }),
  }),

  def({
    name: 'market_snapshot',
    description:
      'Current values of catalog metrics for one subscribed symbol. Percent metrics are already in % (2.5 = 2.5%). ' +
      'null = window still warming up or no trades/ticker yet — never treat it as 0.',
    schema: z.object({ symbol: SymbolArg, metrics: z.array(MetricName).max(20).optional().describe('default: a general overview set') }),
    run: (a, d) => {
      requireSubscribed(d, a.symbol);
      const names = a.metrics?.length ? a.metrics : SNAPSHOT_DEFAULT;
      requireMetrics(names);
      const vals = d.runtime.snapshot(a.symbol, names);
      return {
        symbol: a.symbol,
        at: fmtTime(d.now(), d.tz),
        metrics: Object.fromEntries(names.map((n) => [n, present(n, vals[n])])),
      };
    },
  }),

  def({
    name: 'rank_symbols',
    description: 'Rank all subscribed symbols by the current value of one metric (e.g. "which coin has the strongest buying now").',
    schema: z.object({ metric: MetricName, order: z.enum(['desc', 'asc']).default('desc') }),
    run: (a, d) => {
      requireMetrics([a.metric]);
      const rows = d.runtime.symbols().map((s) => ({ symbol: s.symbol, ...present(a.metric, d.runtime.snapshot(s.symbol, [a.metric])[a.metric]) }));
      const known = rows.filter((r) => r.value !== null).sort((x, y) => (a.order === 'desc' ? y.value! - x.value! : x.value! - y.value!));
      return { metric: a.metric, at: fmtTime(d.now(), d.tz), ranking: known, unavailable: rows.filter((r) => r.value === null).map((r) => r.symbol) };
    },
  }),

  def({
    name: 'metric_stats',
    description:
      'Statistics of a metric\'s 1-second samples over a past time range (first/last/min/max/avg and when extremes happened). ' +
      'History is kept only for the retention period; a range starting earlier returns error "insufficient_data".',
    schema: z.object({ symbol: SymbolArg, metric: MetricName, ...Range }),
    run: (a, d) => {
      // 不要求当前已订阅：取消订阅前采到的历史仍在保留期内可查
      requireMetrics([a.metric]);
      const now = d.now();
      const { from, to } = resolveRange(a, now);
      const retainedFrom = now - d.retentionDays * DAY;
      if (from < retainedFrom) {
        // 不截断成部分结果：用剩余数据回答"上周"会误导（plan §3.1）
        throw new ToolError({
          error: 'insufficient_data',
          retention_days: d.retentionDays,
          retained_from: fmtTime(retainedFrom, d.tz),
          message: `Metric history is only kept for ${d.retentionDays} days. Tell the user the data is insufficient; do not answer from partial data.`,
        });
      }
      const s = d.db.metricStats(a.symbol, a.metric, from, to);
      const p = (v: number | null | undefined) => present(a.metric, v).value;
      const expected = Math.max(1, Math.round((to - from) / 1000));
      if (!s.points) {
        throw new ToolError({
          error: 'no_data', symbol: a.symbol, metric: a.metric,
          message: 'No samples in this range: the symbol was not subscribed or the server was not running. Say so; do not guess.',
        });
      }
      return {
        symbol: a.symbol,
        metric: a.metric,
        unit: present(a.metric, 0).unit,
        range: { from: fmtTime(from, d.tz), to: fmtTime(to, d.tz) },
        samples: s.valued,
        // 覆盖率低说明服务停过或该交易对是中途才订阅的，回答时要说明
        coverage_pct: sig(Math.min(100, (s.points / expected) * 100)),
        data_from: fmtTime(s.first_ts, d.tz),
        data_to: fmtTime(s.last_ts, d.tz),
        first: s.first ? { value: p(s.first.value), at: fmtTime(s.first.ts, d.tz) } : null,
        last: s.last ? { value: p(s.last.value), at: fmtTime(s.last.ts, d.tz) } : null,
        min: s.min_at ? { value: p(s.min_at.value), at: fmtTime(s.min_at.ts, d.tz) } : null,
        max: s.max_at ? { value: p(s.max_at.value), at: fmtTime(s.max_at.ts, d.tz) } : null,
        avg: p(s.avg),
      };
    },
  }),

  def({
    name: 'list_signals',
    description: 'All user-defined Signals with their runtime state (WARMING/ARMED/COOLDOWN/ACTIVE/DISABLED) and condition.',
    schema: z.object({}),
    run: (_a, d) => ({
      signals: d.db.listSignals().map((s) => {
        const st = d.runtime.status(s.id);
        return {
          id: s.id,
          title: s.spec.title,
          symbol: s.spec.market.symbol,
          enabled: s.enabled,
          state: st?.state ?? null,
          ready: st?.ready ?? false,
          condition: describeCondition(s.spec.condition),
          last_event: fmtTime(st?.last_event_ts, d.tz),
        };
      }),
    }),
  }),

  def({
    name: 'get_signal',
    description: 'One Signal\'s definition (metrics with formulas, condition, cooldown) and its current metric values.',
    schema: z.object({ id: z.number().int() }),
    run: (a, d) => {
      const s = d.db.getSignal(a.id);
      if (!s) throw new ToolError({ error: 'not_found', id: a.id });
      const st = d.runtime.status(s.id);
      return {
        id: s.id,
        title: s.spec.title,
        description: s.spec.description,
        symbol: s.spec.market.symbol,
        enabled: s.enabled,
        state: st?.state ?? null,
        ready: st?.ready ?? false,
        condition: describeCondition(s.spec.condition),
        cooldown_seconds: s.spec.cooldown_ms / 1000,
        metrics: s.spec.metrics.map((m) => ({
          name: m.name,
          formula: describeFormula(m),
          unit: metricUnit(m, s.spec.metrics),
          // spec 自定义指标不一定在目录里，保持原始值（百分比为小数）
          current: sig(st?.values[m.name] ?? null),
        })),
        last_event: fmtTime(st?.last_event_ts, d.tz),
      };
    },
  }),

  def({
    name: 'event_stats',
    description:
      'Count Signal triggers in a time range, per signal and optionally per hour (user timezone). ' +
      'Events are kept forever, so any range works.',
    schema: z.object({ signal_id: z.number().int().optional(), by_hour: z.boolean().default(false), ...Range }),
    run: (a, d) => {
      const { from, to } = resolveRange(a, d.now());
      const per = d.db.eventCounts(from, to, a.signal_id ?? null);
      const out: ToolResult = {
        range: { from: fmtTime(from, d.tz), to: fmtTime(to, d.tz) },
        total: per.reduce((n, r) => n + r.n, 0),
        per_signal: per.map((r) => ({
          signal_id: r.signal_id, title: r.title, symbol: r.symbol, count: r.n, first: fmtTime(r.first_ts, d.tz), last: fmtTime(r.last_ts, d.tz),
        })),
      };
      if (a.by_hour) {
        const LIMIT = 50_000;
        const ts = d.db.eventTimestamps(from, to, a.signal_id ?? null, LIMIT);
        const buckets = new Map<string, number>();
        for (const t of ts) {
          const h = fmtTime(t, d.tz)!.slice(0, 13) + ':00';
          buckets.set(h, (buckets.get(h) ?? 0) + 1);
        }
        out.by_hour = [...buckets].map(([hour, count]) => ({ hour, count }));
        if (ts.length >= LIMIT) out.by_hour_truncated = true;
      }
      return out;
    },
  }),

  def({
    name: 'list_events',
    description:
      'Recent trigger events (newest first) with the metric values at trigger time. ' +
      'Values come from the event snapshot, not the current Signal definition. Percent values here are raw fractions (0.01 = 1%).',
    schema: z.object({ signal_id: z.number().int().optional(), limit: z.number().int().min(1).max(20).default(10), ...Range }),
    run: (a, d) => {
      const { from, to } = resolveRange(a, d.now());
      return {
        events: d.db.listEventsBetween(from, to, a.signal_id ?? null, a.limit).map((e) => ({
          id: e.id,
          signal_id: e.signal_id,
          title: e.spec.title,
          symbol: e.symbol,
          at: fmtTime(e.ts, d.tz),
          condition: describeCondition(e.spec.condition),
          leaves: ((e.condition as any)?.leaves ?? []).map((l: any) => ({ expr: l.expr, left: sig(l.left), right: sig(l.right), passed: l.passed })),
          delivery: e.delivery_status,
        })),
      };
    },
  }),

  def({
    name: 'delivery_failures',
    description: 'Failed webhook delivery attempts in a time range: webhook name, HTTP status, error, attempt number.',
    schema: z.object({ limit: z.number().int().min(1).max(20).default(10), ...Range }),
    run: (a, d) => {
      const { from, to } = resolveRange(a, d.now());
      return {
        failures: d.db.failedDeliveriesBetween(from, to, a.limit).map((f) => ({
          at: fmtTime(f.ts, d.tz),
          webhook: f.webhook_name ?? `#${f.webhook_id} (deleted)`,
          event_id: f.event_id,
          attempt: f.attempt,
          http_status: f.http_status,
          error: f.error,
          test: f.is_test,
        })),
      };
    },
  }),
];

export const TOOL_BY_NAME = new Map(TOOLS.map((t) => [t.name, t]));

/** OpenAI 兼容 tools 声明 */
export function llmTools(): LlmTool[] {
  return TOOLS.map((t) => {
    const { $schema: _, ...parameters } = z.toJSONSchema(t.schema, { io: 'input' }) as Record<string, unknown>;
    return { type: 'function', function: { name: t.name, description: t.description, parameters } };
  });
}

/** 执行一次工具调用：参数校验失败 / 工具报错都作为结果回灌给 LLM，而不是中断对话 */
export function runTool(name: string, rawArgs: string, deps: ToolDeps): { args: unknown; result: ToolResult; ok: boolean } {
  const t = TOOL_BY_NAME.get(name);
  if (!t) return { args: rawArgs, result: { error: 'unknown_tool', name, available: TOOLS.map((x) => x.name) }, ok: false };
  let parsed: unknown;
  try {
    parsed = rawArgs.trim() ? JSON.parse(rawArgs) : {};
  } catch {
    return { args: rawArgs, result: { error: 'bad_args', message: 'arguments must be a JSON object' }, ok: false };
  }
  const v = t.schema.safeParse(parsed);
  if (!v.success) return { args: parsed, result: { error: 'bad_args', issues: v.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`) }, ok: false };
  try {
    return { args: v.data, result: t.run(v.data, deps), ok: true };
  } catch (e) {
    if (e instanceof ToolError) return { args: v.data, result: e.payload, ok: false };
    return { args: v.data, result: { error: 'internal', message: (e as Error).message }, ok: false };
  }
}
