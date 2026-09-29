/**
 * 持久化（PRD §26）：Signal / Webhook / Event / Delivery 永久保存；
 * Metric 时间序列按保留期清理；原始 Tick 不落盘（仅内存环形缓存）。
 */
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { SignalSpec, WebhookInput } from '../shared/dsl.ts';

export interface SignalRow {
  id: number;
  spec: SignalSpec;
  webhook_id: number | null;
  enabled: boolean;
  version: number;
  source_text: string;
  created_at: number;
  updated_at: number;
}

export interface WebhookRow extends WebhookInput {
  id: number;
  created_at: number;
}

export interface EventRow {
  id: number;
  signal_id: number;
  signal_version: number;
  ts: number;
  local_ts: number;
  symbol: string;
  snapshot: Record<string, number | null>;
  condition: unknown;
  spec: SignalSpec;
  delivery_status: 'pending' | 'success' | 'failed' | 'none';
}

export interface DeliveryRow {
  id: number;
  event_id: number | null;
  webhook_id: number;
  attempt: number;
  ts: number;
  ok: boolean;
  http_status: number | null;
  latency_ms: number | null;
  error: string | null;
  is_test: boolean;
}

export class Db {
  readonly raw: DatabaseSync;

  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.raw = new DatabaseSync(path);
    this.raw.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      CREATE TABLE IF NOT EXISTS webhooks (
        id INTEGER PRIMARY KEY, name TEXT NOT NULL, url TEXT NOT NULL, method TEXT NOT NULL,
        headers TEXT NOT NULL, secret TEXT NOT NULL, timeout_ms INTEGER NOT NULL,
        max_retries INTEGER NOT NULL, created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS signals (
        id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE, spec TEXT NOT NULL,
        webhook_id INTEGER REFERENCES webhooks(id) ON DELETE SET NULL,
        enabled INTEGER NOT NULL DEFAULT 1, version INTEGER NOT NULL DEFAULT 1,
        source_text TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY, signal_id INTEGER NOT NULL, signal_version INTEGER NOT NULL,
        ts INTEGER NOT NULL, local_ts INTEGER NOT NULL, symbol TEXT NOT NULL,
        snapshot TEXT NOT NULL, condition TEXT NOT NULL, spec TEXT NOT NULL,
        delivery_status TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS events_signal_ts ON events(signal_id, ts DESC);
      CREATE TABLE IF NOT EXISTS deliveries (
        id INTEGER PRIMARY KEY, event_id INTEGER, webhook_id INTEGER NOT NULL, attempt INTEGER NOT NULL,
        ts INTEGER NOT NULL, ok INTEGER NOT NULL, http_status INTEGER, latency_ms INTEGER,
        error TEXT, is_test INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS deliveries_webhook_ts ON deliveries(webhook_id, ts DESC);
      CREATE INDEX IF NOT EXISTS deliveries_event ON deliveries(event_id);
      CREATE TABLE IF NOT EXISTS metric_points (
        symbol TEXT NOT NULL, metric TEXT NOT NULL, ts INTEGER NOT NULL, value REAL,
        PRIMARY KEY (symbol, metric, ts)
      ) WITHOUT ROWID;
    `);
  }

  // ---------- webhooks ----------
  private toWebhook(r: any): WebhookRow {
    return { ...r, headers: JSON.parse(r.headers) };
  }
  listWebhooks(): WebhookRow[] {
    return this.raw.prepare('SELECT * FROM webhooks ORDER BY id DESC').all().map((r) => this.toWebhook(r));
  }
  getWebhook(id: number): WebhookRow | undefined {
    const r = this.raw.prepare('SELECT * FROM webhooks WHERE id = ?').get(id);
    return r ? this.toWebhook(r) : undefined;
  }
  insertWebhook(w: WebhookInput): number {
    const r = this.raw
      .prepare(
        'INSERT INTO webhooks (name, url, method, headers, secret, timeout_ms, max_retries, created_at) VALUES (?,?,?,?,?,?,?,?)',
      )
      .run(w.name, w.url, w.method, JSON.stringify(w.headers), w.secret, w.timeout_ms, w.max_retries, Date.now());
    return Number(r.lastInsertRowid);
  }
  updateWebhook(id: number, w: WebhookInput) {
    this.raw
      .prepare('UPDATE webhooks SET name=?, url=?, method=?, headers=?, secret=?, timeout_ms=?, max_retries=? WHERE id=?')
      .run(w.name, w.url, w.method, JSON.stringify(w.headers), w.secret, w.timeout_ms, w.max_retries, id);
  }
  deleteWebhook(id: number) {
    this.raw.prepare('UPDATE signals SET webhook_id = NULL WHERE webhook_id = ?').run(id);
    this.raw.prepare('DELETE FROM webhooks WHERE id = ?').run(id);
  }

  // ---------- signals ----------
  private toSignal(r: any): SignalRow {
    return { ...r, spec: JSON.parse(r.spec), enabled: !!r.enabled };
  }
  listSignals(): SignalRow[] {
    return this.raw.prepare('SELECT * FROM signals ORDER BY id DESC').all().map((r) => this.toSignal(r));
  }
  getSignal(id: number): SignalRow | undefined {
    const r = this.raw.prepare('SELECT * FROM signals WHERE id = ?').get(id);
    return r ? this.toSignal(r) : undefined;
  }
  signalNameTaken(name: string, exceptId?: number) {
    return !!this.raw.prepare('SELECT 1 FROM signals WHERE name = ? AND id != ?').get(name, exceptId ?? -1);
  }
  insertSignal(spec: SignalSpec, webhookId: number | null, sourceText: string): number {
    const now = Date.now();
    const r = this.raw
      .prepare('INSERT INTO signals (name, spec, webhook_id, enabled, version, source_text, created_at, updated_at) VALUES (?,?,?,1,1,?,?,?)')
      .run(spec.name, JSON.stringify(spec), webhookId, sourceText, now, now);
    return Number(r.lastInsertRowid);
  }
  updateSignal(id: number, spec: SignalSpec, webhookId: number | null) {
    this.raw
      .prepare('UPDATE signals SET name=?, spec=?, webhook_id=?, version=version+1, updated_at=? WHERE id=?')
      .run(spec.name, JSON.stringify(spec), webhookId, Date.now(), id);
  }
  setSignalEnabled(id: number, enabled: boolean) {
    this.raw.prepare('UPDATE signals SET enabled=?, updated_at=? WHERE id=?').run(enabled ? 1 : 0, Date.now(), id);
  }
  deleteSignal(id: number) {
    // 事件与投递日志永久保留（PRD §26），仅删除 Signal 定义
    this.raw.prepare('DELETE FROM signals WHERE id = ?').run(id);
  }

  // ---------- events ----------
  private toEvent(r: any): EventRow {
    return { ...r, snapshot: JSON.parse(r.snapshot), condition: JSON.parse(r.condition), spec: JSON.parse(r.spec) };
  }
  insertEvent(e: Omit<EventRow, 'id'>): number {
    const r = this.raw
      .prepare(
        'INSERT INTO events (signal_id, signal_version, ts, local_ts, symbol, snapshot, condition, spec, delivery_status) VALUES (?,?,?,?,?,?,?,?,?)',
      )
      .run(
        e.signal_id, e.signal_version, e.ts, e.local_ts, e.symbol,
        JSON.stringify(e.snapshot), JSON.stringify(e.condition), JSON.stringify(e.spec), e.delivery_status,
      );
    return Number(r.lastInsertRowid);
  }
  setEventDelivery(id: number, status: EventRow['delivery_status']) {
    this.raw.prepare('UPDATE events SET delivery_status = ? WHERE id = ?').run(status, id);
  }
  listEvents(signalId: number | null, limit = 50): EventRow[] {
    const rows =
      signalId === null
        ? this.raw.prepare('SELECT * FROM events ORDER BY id DESC LIMIT ?').all(limit)
        : this.raw.prepare('SELECT * FROM events WHERE signal_id = ? ORDER BY id DESC LIMIT ?').all(signalId, limit);
    return rows.map((r) => this.toEvent(r));
  }
  getEvent(id: number): EventRow | undefined {
    const r = this.raw.prepare('SELECT * FROM events WHERE id = ?').get(id);
    return r ? this.toEvent(r) : undefined;
  }
  lastEventTs(signalId: number): number | null {
    const r = this.raw.prepare('SELECT MAX(ts) AS ts FROM events WHERE signal_id = ?').get(signalId) as any;
    return r?.ts ?? null;
  }

  // ---------- deliveries ----------
  private toDelivery(r: any): DeliveryRow {
    return { ...r, ok: !!r.ok, is_test: !!r.is_test };
  }
  insertDelivery(d: Omit<DeliveryRow, 'id'>) {
    this.raw
      .prepare(
        'INSERT INTO deliveries (event_id, webhook_id, attempt, ts, ok, http_status, latency_ms, error, is_test) VALUES (?,?,?,?,?,?,?,?,?)',
      )
      .run(d.event_id, d.webhook_id, d.attempt, d.ts, d.ok ? 1 : 0, d.http_status, d.latency_ms, d.error, d.is_test ? 1 : 0);
  }
  listDeliveries(opts: { webhookId?: number; eventId?: number; limit?: number }): DeliveryRow[] {
    const limit = opts.limit ?? 50;
    const rows =
      opts.eventId !== undefined
        ? this.raw.prepare('SELECT * FROM deliveries WHERE event_id = ? ORDER BY id').all(opts.eventId)
        : this.raw.prepare('SELECT * FROM deliveries WHERE webhook_id = ? ORDER BY id DESC LIMIT ?').all(opts.webhookId ?? -1, limit);
    return rows.map((r) => this.toDelivery(r));
  }
  webhookStats(webhookId: number) {
    return this.raw
      .prepare(
        `SELECT SUM(ok) AS success, SUM(1 - ok) AS failed, AVG(CASE WHEN ok THEN latency_ms END) AS avg_latency_ms,
                MAX(ts) AS last_ts,
                (SELECT error FROM deliveries WHERE webhook_id = ? AND ok = 0 ORDER BY id DESC LIMIT 1) AS last_error
         FROM deliveries WHERE webhook_id = ?`,
      )
      .get(webhookId, webhookId) as {
      success: number | null;
      failed: number | null;
      avg_latency_ms: number | null;
      last_ts: number | null;
      last_error: string | null;
    };
  }

  // ---------- metric points ----------
  insertPoints(points: { symbol: string; metric: string; ts: number; value: number | null }[]) {
    if (!points.length) return;
    const stmt = this.raw.prepare('INSERT OR REPLACE INTO metric_points (symbol, metric, ts, value) VALUES (?,?,?,?)');
    this.raw.exec('BEGIN');
    try {
      for (const p of points) stmt.run(p.symbol, p.metric, p.ts, p.value);
      this.raw.exec('COMMIT');
    } catch (e) {
      this.raw.exec('ROLLBACK');
      throw e;
    }
  }
  queryPoints(symbol: string, metric: string, from: number, to: number, stepMs: number) {
    return this.raw
      .prepare(
        `SELECT (ts / ?) * ? AS ts, AVG(value) AS value FROM metric_points
         WHERE symbol = ? AND metric = ? AND ts BETWEEN ? AND ? GROUP BY ts / ? ORDER BY ts`,
      )
      .all(stepMs, stepMs, symbol, metric, from, to, stepMs) as { ts: number; value: number | null }[];
  }
  pruneMetricPoints(before: number) {
    this.raw.prepare('DELETE FROM metric_points WHERE ts < ?').run(before);
  }
}
