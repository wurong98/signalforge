/**
 * 自然语言 → Signal DSL（PRD §7 §8）。
 * LLM 只负责"理解 + 生成结构"，输出必须通过 validateSpec；
 * 校验失败会把错误回灌给 LLM 修复一次，仍失败则回落到规则解析器。
 */
import { CATALOG } from '../../shared/catalog.ts';
import { AGGREGATIONS, COMBINE_OPS, FIELDS, OPERATORS, WINDOWS, validateSpec } from '../../shared/dsl.ts';
import type { ParseOutput } from './rules.ts';
import { parseWithRules } from './rules.ts';

export interface LlmConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
}

const SYSTEM_PROMPT = `You convert a user's natural-language market-monitoring request into a Signal DSL JSON for Binance Spot real-time data.
You NEVER decide at runtime whether a signal fires; you only produce a structured definition.

Available data (V1): only the Binance Spot "aggTrade" stream. Fields: p=price, q=quantity, T=trade time, m=buyer_is_maker.
- Aggressive BUY (taker buy) = buyer_is_maker:false. Aggressive SELL (taker sell) = buyer_is_maker:true.
- "notional" = price × quantity (in quote currency, e.g. USDT).
Depth / order book / bookTicker are NOT available in V1 — if the user asks for them, say so in "unsupported".

DSL schema (TypeScript):
type Spec = {
  name: string;            // slug: ^[a-z0-9][a-z0-9-]{0,63}$, e.g. "btc-buy-pressure-10s"
  title: string;           // short human title, English, e.g. "BTC Buy Pressure 10s"
  description: string;     // the user's intent, 1 sentence
  market: { exchange: "binance"; product: "spot"; symbol: string }; // e.g. "BTCUSDT"
  metrics: Metric[];       // 1..16; a combine metric may only reference metrics defined BEFORE it
  condition: Condition;
  cooldown_ms: number;     // default 10000 unless the user says otherwise
};
type Metric =
  | { name: string; kind: "window"; stream: "aggTrade"; window: ${WINDOWS.map((w) => `"${w}"`).join('|')};
      filter: { buyer_is_maker?: boolean }; field: ${FIELDS.map((f) => `"${f}"`).join('|')};
      aggregation: ${AGGREGATIONS.map((a) => `"${a}"`).join('|')} }   // "return" = (last-first)/first, price only; "delta" = last-first, price only
  | { name: string; kind: "combine"; op: ${COMBINE_OPS.map((o) => `"${o}"`).join('|')}; a: string; b: string }; // ratio=a/b, imbalance=(a-b)/(a+b), diff=a-b
type Condition =
  | { left: string /* metric name */; operator: ${OPERATORS.map((o) => `"${o}"`).join('|')};
      right: { metric: string; multiplier: number } | { value: number } }
  | { op: "and" | "or"; conditions: Condition[] };
Metric names: ^[a-z][a-z0-9_]{0,63}$. Percentages are fractions: 0.1% => 0.001.

Conventions (prefer these names when they fit): ${CATALOG.filter((m) => m.name.endsWith('_10s') || m.name === 'last_price').map((m) => m.name).join(', ')} (same pattern for other windows).
For "A is N times B", use { left: A, operator: ">", right: { metric: B, multiplier: N } } — NEVER create a ratio metric for this (a ratio is undefined when B = 0).
Noise floor: a relative comparison (A > B × N) also fires on tiny volume (e.g. $10 buy vs $0 sell). Unless the user gave an absolute
threshold, wrap it as { op: "and", conditions: [ <the comparison>, { left: A, operator: ">=", right: { value: FLOOR } } ] } where FLOOR is
50000 USDT for BTC, 20000 for ETH, 5000 otherwise (scale linearly with window: that's for 10s), and state this floor in assumptions.
Windows must be one of ${WINDOWS.join(', ')}; if the user asks for another length, pick the nearest and add an assumption.
Only if no symbol/coin is mentioned at all, use BTCUSDT and add an assumption. Do not list trivial assumptions (e.g. unit conversions).

Example — input: "BTC 最近 10 秒主动买入金额超过主动卖出金额 3 倍时调用我的 webhook"
{"spec":{"name":"btc-buy-pressure-10s","title":"BTC Buy Pressure 10s","description":"BTC 10 秒主动买入额超过主动卖出额 3 倍",
"market":{"exchange":"binance","product":"spot","symbol":"BTCUSDT"},
"metrics":[{"name":"buy_notional_10s","kind":"window","stream":"aggTrade","window":"10s","filter":{"buyer_is_maker":false},"field":"notional","aggregation":"sum"},
{"name":"sell_notional_10s","kind":"window","stream":"aggTrade","window":"10s","filter":{"buyer_is_maker":true},"field":"notional","aggregation":"sum"}],
"condition":{"op":"and","conditions":[{"left":"buy_notional_10s","operator":">","right":{"metric":"sell_notional_10s","multiplier":3}},
{"left":"buy_notional_10s","operator":">=","right":{"value":50000}}]},"cooldown_ms":10000},
"explanation":"基于 BTCUSDT aggTrade：统计最近 10 秒主动买入成交额 Σ(p×q | m=false) 与主动卖出成交额 Σ(p×q | m=true)，当买入额 > 卖出额 × 3 时触发。",
"assumptions":["为避免成交稀少时误触发，额外要求 10 秒主动买入额 ≥ 50,000 USDT（可修改）"],"unsupported":null}

Reply with ONLY a JSON object, no markdown:
{ "spec": Spec, "explanation": string /* in the user's language: what raw data, which formula, when it fires */,
  "assumptions": string[] /* in the user's language */, "unsupported": string | null }`;

async function callLlm(cfg: LlmConfig, messages: { role: string; content: string }[]): Promise<string> {
  const res = await fetch(`${cfg.baseUrl.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${cfg.apiKey}` },
    body: JSON.stringify({ model: cfg.model, messages, temperature: 0.1 }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) throw new Error(`LLM HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const data: any = await res.json();
  const content = data?.choices?.[0]?.message?.content;
  if (typeof content !== 'string') throw new Error('LLM returned no content');
  return content;
}

/** 去掉推理模型的 <think> 块与代码围栏，截取最外层 JSON */
export function extractJson(text: string): unknown {
  const cleaned = text.replace(/<think>[\s\S]*?<\/think>/g, '').replace(/```(?:json)?/g, '');
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('no JSON object in LLM output');
  return JSON.parse(cleaned.slice(start, end + 1));
}

export async function parseNaturalLanguage(
  text: string,
  cfg: LlmConfig | null,
): Promise<(ParseOutput & { warnings: string[] }) | { error: string; warnings: string[] }> {
  const warnings: string[] = [];
  if (cfg) {
    const messages = [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: text },
    ];
    for (let round = 0; round < 2; round++) {
      let raw: string;
      try {
        raw = await callLlm(cfg, messages);
      } catch (e) {
        warnings.push(`LLM 调用失败，已回落到规则解析：${(e as Error).message}`);
        break;
      }
      let obj: any;
      try {
        obj = extractJson(raw);
      } catch (e) {
        messages.push({ role: 'assistant', content: raw }, { role: 'user', content: `Invalid JSON: ${(e as Error).message}. Reply with ONLY the JSON object.` });
        continue;
      }
      if (obj?.unsupported && !obj?.spec) return { error: `暂不支持：${obj.unsupported}`, warnings };
      const v = validateSpec(obj?.spec);
      if (v.ok) {
        if (obj.unsupported) warnings.push(`部分需求暂不支持：${obj.unsupported}`);
        return {
          spec: v.spec,
          explanation: String(obj.explanation ?? ''),
          assumptions: Array.isArray(obj.assumptions) ? obj.assumptions.map(String) : [],
          parser: 'llm',
          warnings,
        };
      }
      messages.push(
        { role: 'assistant', content: raw },
        { role: 'user', content: `The spec failed validation:\n${v.errors.join('\n')}\nFix it and reply with ONLY the corrected JSON object.` },
      );
      if (round === 1) warnings.push(`LLM 输出未通过校验，已回落到规则解析：${v.errors.join('; ')}`);
    }
  }
  const r = parseWithRules(text);
  if ('error' in r) return { error: r.error, warnings };
  const v = validateSpec(r.spec);
  if (!v.ok) return { error: v.errors.join('; '), warnings };
  return { ...r, spec: v.spec, warnings };
}
