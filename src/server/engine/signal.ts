/**
 * Signal 条件求值与状态机（PRD §22 §23）。
 *
 * 状态：
 *   WARMING  — 所需窗口尚不完整（启动 / 重连后），不求值
 *   ARMED    — 条件为假，允许触发
 *   COOLDOWN — 刚触发，冷却中，不触发
 *   ACTIVE   — 条件仍为真但已触发过（或冷却结束时仍为真），需先回到假
 *
 * 转移：
 *   WARMING  →(就绪，条件假) ARMED ；→(就绪，条件真) ACTIVE（未观测到"由假变真"，不触发）
 *   ARMED    →(条件真) 触发 → COOLDOWN
 *   COOLDOWN →(到期，条件假) ARMED ；→(到期，条件真) ACTIVE
 *   ACTIVE   →(条件假) ARMED
 *   任意     →(窗口不完整) WARMING
 *
 * 即：每次触发必须对应一次"未满足 → 满足"的边沿，且两次触发间隔 ≥ cooldown。
 */
import type { Condition, LeafCondition, Operator, SignalSpec } from '../../shared/dsl.ts';
import { describeCondition, describeOperand, isLeaf } from '../../shared/dsl.ts';
import type { MetricValue } from './window.ts';

export type SignalState = 'WARMING' | 'ARMED' | 'COOLDOWN' | 'ACTIVE';

export interface LeafResult {
  expr: string;
  left_metric: string;
  left: number | null;
  operator: Operator;
  right_expr: string;
  right: number | null;
  /** 若右侧为 metric × k：left / metric 的实际倍数，便于 Explain */
  ratio?: number | null;
  multiplier?: number;
  passed: boolean;
}

export interface EvalResult {
  passed: boolean;
  /** 有指标为 null（窗口不完整/分母为 0 等）时 complete = false */
  complete: boolean;
  leaves: LeafResult[];
}

const cmp = (a: number, op: Operator, b: number) =>
  op === '>' ? a > b : op === '>=' ? a >= b : op === '<' ? a < b : op === '<=' ? a <= b : a === b;

function evalLeaf(c: LeafCondition, v: Record<string, MetricValue>): LeafResult {
  const left = v[c.left] ?? null;
  let right: number | null;
  let ratio: number | null | undefined;
  let multiplier: number | undefined;
  if ('value' in c.right) right = c.right.value;
  else {
    const base = v[c.right.metric] ?? null;
    right = base === null ? null : base * c.right.multiplier;
    multiplier = c.right.multiplier;
    ratio = left === null || base === null || base === 0 ? null : left / base;
  }
  return {
    expr: describeCondition(c),
    left_metric: c.left,
    left,
    operator: c.operator,
    right_expr: describeOperand(c.right),
    right,
    ratio,
    multiplier,
    passed: left !== null && right !== null && cmp(left, c.operator, right),
  };
}

export function evaluateCondition(c: Condition, v: Record<string, MetricValue>): EvalResult {
  if (isLeaf(c)) {
    const r = evalLeaf(c, v);
    return { passed: r.passed, complete: r.left !== null && r.right !== null, leaves: [r] };
  }
  const subs = c.conditions.map((x) => evaluateCondition(x, v));
  return {
    passed: c.op === 'and' ? subs.every((s) => s.passed) : subs.some((s) => s.passed),
    complete: subs.every((s) => s.complete),
    leaves: subs.flatMap((s) => s.leaves),
  };
}

/** 主仪表：第一个叶子条件。右侧为 metric×k 时展示倍数，否则展示左值。 */
export function gauge(r: EvalResult): { value: number | null; threshold: number | null; kind: 'ratio' | 'value' } {
  const l = r.leaves[0];
  if (!l) return { value: null, threshold: null, kind: 'value' };
  if (l.multiplier !== undefined) return { value: l.ratio ?? null, threshold: l.multiplier, kind: 'ratio' };
  return { value: l.left, threshold: l.right, kind: 'value' };
}

export interface Transition {
  from: SignalState;
  to: SignalState;
  fire: boolean;
}

export class SignalStateMachine {
  state: SignalState = 'WARMING';
  cooldownUntil = 0;
  constructor(public cooldownMs: number) {}

  /**
   * @param ready 所需指标窗口是否全部完整
   * @param passed 条件是否满足（ready 为 false 时忽略）
   */
  step(now: number, ready: boolean, passed: boolean): Transition {
    const from = this.state;
    let fire = false;
    if (!ready) this.state = 'WARMING';
    else
      switch (this.state) {
        case 'WARMING':
          this.state = passed ? 'ACTIVE' : 'ARMED';
          break;
        case 'ARMED':
          if (passed) {
            fire = true;
            this.state = 'COOLDOWN';
            this.cooldownUntil = now + this.cooldownMs;
          }
          break;
        case 'COOLDOWN':
          if (now >= this.cooldownUntil) this.state = passed ? 'ACTIVE' : 'ARMED';
          break;
        case 'ACTIVE':
          if (!passed) this.state = 'ARMED';
          break;
      }
    return { from, to: this.state, fire };
  }
}

export function requiredWindowMs(spec: SignalSpec): number {
  let ms = 0;
  for (const m of spec.metrics) if (m.kind === 'window') ms = Math.max(ms, Number(m.window.slice(0, -1)) * 1000);
  return ms;
}

/**
 * spec 是否依赖 24h ticker。
 * 依赖时必须等到第一条 ticker 到达才算就绪：否则就绪瞬间 ticker 还是 null（条件假 → ARMED），
 * 下一秒 ticker 到达、条件转真，会被误判成"由假变真"的边沿而触发——这正是启动时已满足的条件。
 * 等到 ticker 就绪后再看条件，才能保证"启动时已满足不触发"（PRD §23）在长周期指标上同样成立。
 */
export function requiresTicker(spec: SignalSpec): boolean {
  return spec.metrics.some((m) => m.kind === 'ticker');
}
