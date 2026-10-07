/**
 * 助手对话循环（docs/llm-assistant-plan.md §4）：LLM 选工具 → 只读工具取数 → LLM 组织回答。
 * - 关闭思考：带工具时开启思考必须逐轮回传 reasoning_content，对话层也不需要深推理；
 * - 服务端无状态：前端每次带上历史，助手消息附带上一轮取数摘要（digest），
 *   让"超过现在 3 倍"这类追问能引用上一轮的数值；
 * - 回答中的数字只能来自工具结果（提示词约束 + 前端展示 trace 供核对）。
 */
import { CATALOG, catalogDescription } from '../../shared/catalog.ts';
import type { LlmCall, LlmMessage } from './llm.ts';
import { stripThink } from './llm.ts';
import type { ToolDeps } from './tools.ts';
import { fmtTime, llmTools, runTool } from './tools.ts';

export const MAX_ROUNDS = 6;
export const MAX_HISTORY = 20;
export const MAX_HISTORY_CHARS = 16_000;
const MAX_RESULT_CHARS = 4_000;
const MAX_DIGEST_CHARS = 1_500;

export interface ChatTurn {
  role: 'user' | 'assistant';
  content: string;
  /** 助手消息附带的上一轮取数摘要（由服务端生成、前端原样回传） */
  digest?: string;
}

export interface TraceItem {
  tool: string;
  args: unknown;
  result: unknown;
  ok: boolean;
}

export interface ChatResult {
  answer: string;
  trace: TraceItem[];
  digest: string;
}

/** 目录指标按"基名 + 可用窗口"压缩列出，避免把 70 多个名字逐个塞进提示词 */
function catalogSummary(): string {
  const groups = new Map<string, string[]>();
  for (const m of CATALOG) {
    // ticker 指标名以 _24h 结尾但不是窗口，原样列出
    const base = m.kind === 'ticker' ? m.name : m.name.replace(/_(\d+[smh])$/, '');
    const w = m.name.slice(base.length + 1);
    if (!groups.has(base)) groups.set(base, []);
    if (w) groups.get(base)!.push(w);
  }
  return [...groups]
    .map(([base, ws]) => `- ${base}${ws.length ? `_{${ws.join(',')}}` : ''}: ${catalogDescription(ws.length ? `${base}_${ws[0]}` : base)}`)
    .join('\n');
}

export function systemPrompt(deps: Pick<ToolDeps, 'now' | 'tz' | 'retentionDays'>): string {
  return `You are the market assistant of Binance Signal Studio (Binance Spot, real-time aggTrade + 24h ticker).
Current time: ${fmtTime(deps.now(), deps.tz)} (${deps.tz}). Use this timezone for every time you mention or pass to tools.

What you do: answer questions about the market and about the user's Signals / trigger events / webhook deliveries,
by calling the read-only tools. You cannot create, edit, enable or disable Signals. If the user wants a new alert,
tell them to describe it on the Create page (a later version will let you draft it here).

Hard rules:
1. Every number in your answer MUST come from a tool result in this conversation. If you did not get it, say you don't have it.
   Never estimate, extrapolate or fill gaps.
2. null means the window is still warming up or there is no data yet — say so, never call it 0.
3. If a tool returns "insufficient_data", tell the user metric history is only kept for ${deps.retentionDays} days and the data is
   not enough to answer. Do not answer from a shorter range instead. Trigger events and webhook deliveries are kept forever.
4. If a tool returns "not_subscribed" or "no_data", say which symbol is not covered and how to cover it (create a Signal on it, or add it to SYMBOLS).
5. State facts only. No price predictions, no buy/sell advice — decline politely if asked.
6. If coverage_pct is well below 100, mention that the range has gaps.
7. Symbols are full Binance spot pairs (BTC => BTCUSDT unless the user names another quote).
8. "Supported" vs "subscribed": every TRADING Binance Spot pair is supported (search_binance_symbols); only subscribed pairs
   (list_symbols) have live metrics right now. When asked which pairs are supported / whether a coin can be monitored, answer
   with search_binance_symbols, and mention which are already subscribed. If the user wants the full list, call it with
   list=true and output the symbols (comma-separated), and point them to the Data Sources page which lists every pair.
   Never say you "cannot list them". On 0 matches, show the "similar" suggestions; don't lecture.

Metrics (window suffix in braces; windows slide on exchange trade time; tools already convert percent metrics to %):
${catalogSummary()}

Answer in the user's language, concisely: conclusion first, then the key numbers with units and the time they refer to.
Plain text; short "- " bullet lists are fine; no tables, no headings.`;
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…(truncated)` : s);

/** 本轮取数摘要：下一轮作为助手消息的附注回传，便于引用"刚才的数" */
export function digestOf(trace: TraceItem[]): string {
  const parts = trace.filter((t) => t.ok).map((t) => `${t.tool}(${JSON.stringify(t.args)}) → ${clip(JSON.stringify(t.result), 600)}`);
  return clip(parts.join('\n'), MAX_DIGEST_CHARS);
}

/** 历史截断：保留最近的消息，且总长不超过上限；第一条必须是 user */
export function trimHistory(turns: ChatTurn[]): ChatTurn[] {
  const out: ChatTurn[] = [];
  let chars = 0;
  for (let i = turns.length - 1; i >= 0 && out.length < MAX_HISTORY; i--) {
    const t = turns[i];
    const len = t.content.length + (t.digest?.length ?? 0);
    if (chars + len > MAX_HISTORY_CHARS && out.length) break;
    chars += len;
    out.unshift(t);
  }
  while (out.length && out[0].role !== 'user') out.shift();
  return out;
}

function toLlm(t: ChatTurn): LlmMessage {
  if (t.role === 'assistant' && t.digest) {
    return { role: 'assistant', content: `${t.content}\n\n[data behind this answer]\n${clip(t.digest, MAX_DIGEST_CHARS)}` };
  }
  return { role: t.role, content: t.content };
}

export async function runChat(turns: ChatTurn[], deps: { call: LlmCall; tools: ToolDeps; signal?: AbortSignal }): Promise<ChatResult> {
  const history = trimHistory(turns);
  if (!history.length || history[history.length - 1].role !== 'user') throw new Error('last message must be from the user');
  const messages: LlmMessage[] = [{ role: 'system', content: systemPrompt(deps.tools) }, ...history.map(toLlm)];
  const tools = llmTools();
  const trace: TraceItem[] = [];

  for (let round = 0; round <= MAX_ROUNDS; round++) {
    const last = round === MAX_ROUNDS;
    if (last) {
      // 步数用完：不再给工具，逼它基于已有结果作答
      messages.push({ role: 'user', content: 'Tool budget exhausted. Answer now using only the tool results above; say what you could not find.' });
    }
    const msg = await deps.call(messages, { thinking: false, temperature: 0.2, tools: last ? undefined : tools, signal: deps.signal });
    if (!msg.tool_calls?.length) {
      return { answer: stripThink(msg.content ?? ''), trace, digest: digestOf(trace) };
    }
    messages.push({ role: 'assistant', content: msg.content ?? null, tool_calls: msg.tool_calls });
    for (const c of msg.tool_calls) {
      const r = await runTool(c.function.name, c.function.arguments ?? '', deps.tools);
      trace.push({ tool: c.function.name, args: r.args, result: r.result, ok: r.ok });
      messages.push({ role: 'tool', tool_call_id: c.id, content: clip(JSON.stringify(r.result), MAX_RESULT_CHARS) });
    }
  }
  // 不可达：最后一轮不带工具，模型只能直接回答
  throw new Error('chat loop ended without an answer');
}
