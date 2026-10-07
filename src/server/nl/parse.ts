/**
 * 自然语言 → Signal DSL（PRD §7 §8）。
 * LLM 只负责"理解 + 生成结构"，输出必须通过 validateSpec；
 * 校验失败会把错误回灌给 LLM 修复一次，仍失败则回落到规则解析器。
 */
import { CATALOG } from '../../shared/catalog.ts';
import { AGGREGATIONS, COMBINE_OPS, FIELDS, OPERATORS, TICKER_FIELDS, WINDOWS, validateSpec } from '../../shared/dsl.ts';
import type { ParseOutput } from './rules.ts';
import { parseWithRules } from './rules.ts';

export interface LlmConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
}

const MAX_WINDOW = WINDOWS[WINDOWS.length - 1];

const SYSTEM_PROMPT = `You convert a user's natural-language market-monitoring request into a Signal DSL JSON for Binance Spot real-time data.
You NEVER decide at runtime whether a signal fires; you only produce a structured definition.

Available data — two Binance Spot public streams:
1. "aggTrade" (window metrics, max ${MAX_WINDOW}): p=price, q=quantity, T=trade time, m=buyer_is_maker.
   - Aggressive BUY (taker buy) = buyer_is_maker:false. Aggressive SELL (taker sell) = buyer_is_maker:true.
   - "notional" = price × quantity (in quote currency, e.g. USDT).
2. "ticker" (24h rolling statistics, computed by the exchange and pushed every second — usable the moment it arrives, no warmup):
   c=last price, h=24h high, l=24h low, p=24h change, P=24h change percent, v=24h base volume, q=24h quote volume.
Depth / order book are NOT available — if the user asks for them, say so in "unsupported".

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
  | { name: string; kind: "ticker"; stream: "ticker"; field: ${TICKER_FIELDS.map((f) => `"${f}"`).join('|')} }  // 24h rolling stat, see mapping below
  | { name: string; kind: "combine"; op: ${COMBINE_OPS.map((o) => `"${o}"`).join('|')}; a: string; b: string }; // ratio=a/b, imbalance=(a-b)/(a+b), diff=a-b
type Condition =
  | { left: string /* metric name */; operator: ${OPERATORS.map((o) => `"${o}"`).join('|')};
      right: { metric: string; multiplier: number } | { value: number } }
  | { op: "and" | "or"; conditions: Condition[] };
Metric names: ^[a-z][a-z0-9_]{0,63}$. Percentages are fractions: 0.1% => 0.001.

ticker field mapping: last_price=c, high_24h=h, low_24h=l, change_24h=p, change_pct_24h=P, volume_24h=v, quote_volume_24h=q.
change_pct_24h is stored as a FRACTION (P = "2.345" => 0.02345), same rule as "return".

Conventions (prefer these names when they fit): ${CATALOG.filter((m) => m.name.endsWith('_10s') || m.name === 'last_price').map((m) => m.name).join(', ')} (same pattern for other windows).
CVD / volume delta / 主动净买入 => volume_delta_<w> = { kind:"combine", op:"diff", a: buy_notional_<w>, b: sell_notional_<w> }, defined AFTER both
sums (it is the net aggressive buy notional INSIDE the window — there is no ever-growing cumulative CVD since startup).
"price up with CVD support" => AND of return_<w> and volume_delta_<w> > 0; "price up but CVD negative" => return_<w> > 0 AND volume_delta_<w> < 0.
When the user gives no CVD threshold, use 0 and add an assumption that a USDT threshold filters out near-zero flips.
For "A is N times B", use { left: A, operator: ">", right: { metric: B, multiplier: N } } — NEVER create a ratio metric for this (a ratio is undefined when B = 0).
Noise floor: a relative comparison (A > B × N) also fires on tiny volume (e.g. $10 buy vs $0 sell). Unless the user gave an absolute
threshold, wrap it as { op: "and", conditions: [ <the comparison>, { left: A, operator: ">=", right: { value: FLOOR } } ] } where FLOOR is
50000 USDT for BTC, 20000 for ETH, 5000 otherwise (scale linearly with window: that's for 10s), and state this floor in assumptions.
Windows must be one of ${WINDOWS.join(', ')}; if the user asks for another length, pick the nearest and add an assumption.

Long periods — a window metric can NEVER exceed ${MAX_WINDOW}. Any 24h / daily request MUST use kind:"ticker"; never silently
downgrade it to a short window, that is a different signal:
- "24h new low"  => metrics [ last_1s = window(aggTrade, 1s, price, last), low_24h = ticker.low_24h ],
                     condition { left: "last_1s", operator: "<", right: { metric: "low_24h", multiplier: 1 } }.
  A fresh trade printing strictly below the ticker's last published low IS the instant a new low is made; the ticker then
  catches up and the condition goes false again — so every new low is a clean false→true edge and cooldown does the rate
  limiting. Use STRICT inequality: "<=" would stay true for the whole slide and fire only once.
- "24h new high" => same, with high_24h and ">".
- "24h change exceeds N%" => ticker.change_pct_24h >= N/100 (or the two-sided OR when the user just said "涨跌幅"), no window metric needed.
- "24h volume above X" => ticker.quote_volume_24h >= X.
Add an assumption that it triggers once per new high/low edge, rate-limited by cooldown_ms, whenever the user asked for a limit
("every minute" => cooldown_ms 60000). Mix freely: an AND of a ticker threshold and a window metric expresses "24h volume high AND
a 10s spike".

Only if no symbol/coin is mentioned at all, use BTCUSDT and add an assumption. Do not list trivial assumptions (e.g. unit conversions).

Example 1 — input: "BTC 最近 10 秒主动买入金额超过主动卖出金额 3 倍时调用我的 webhook"
{"spec":{"name":"btc-buy-pressure-10s","title":"BTC Buy Pressure 10s","description":"BTC 10 秒主动买入额超过主动卖出额 3 倍",
"market":{"exchange":"binance","product":"spot","symbol":"BTCUSDT"},
"metrics":[{"name":"buy_notional_10s","kind":"window","stream":"aggTrade","window":"10s","filter":{"buyer_is_maker":false},"field":"notional","aggregation":"sum"},
{"name":"sell_notional_10s","kind":"window","stream":"aggTrade","window":"10s","filter":{"buyer_is_maker":true},"field":"notional","aggregation":"sum"}],
"condition":{"op":"and","conditions":[{"left":"buy_notional_10s","operator":">","right":{"metric":"sell_notional_10s","multiplier":3}},
{"left":"buy_notional_10s","operator":">=","right":{"value":50000}}]},"cooldown_ms":10000},
"explanation":"基于 BTCUSDT aggTrade：统计最近 10 秒主动买入成交额 Σ(p×q | m=false) 与主动卖出成交额 Σ(p×q | m=true)，当买入额 > 卖出额 × 3 时触发。",
"assumptions":["为避免成交稀少时误触发，额外要求 10 秒主动买入额 ≥ 50,000 USDT（可修改）"],"unsupported":null}

Example 2 — input: "BTC 创 24 小时新低时提醒我，每分钟最多一次"
{"spec":{"name":"btc-24h-new-low","title":"BTC 24h New Low","description":"BTC 跌破 24 小时最低价时提醒，每分钟最多一次",
"market":{"exchange":"binance","product":"spot","symbol":"BTCUSDT"},
"metrics":[{"name":"last_1s","kind":"window","stream":"aggTrade","window":"1s","filter":{},"field":"price","aggregation":"last"},
{"name":"low_24h","kind":"ticker","stream":"ticker","field":"low_24h"}],
"condition":{"left":"last_1s","operator":"<","right":{"metric":"low_24h","multiplier":1}},"cooldown_ms":60000},
"explanation":"aggTrade 取最近 1 秒最新成交价，ticker 流（交易所每秒推送）取 24h 最低价；新成交价严格低于 24h 最低价，说明刚刚创下 24 小时新低，ticker 下一秒即刷新到新低，条件随之解除。",
"assumptions":["每次创新低的边沿触发一次，60 秒冷却内不重复提醒"],"unsupported":null}

Example 3 — input: "XPL 5 分钟涨幅超过 2%，同时 CVD 为正"
{"spec":{"name":"xpl-pump-cvd-pos-5m","title":"XPL Pump + CVD Positive 5m","description":"XPL 5 分钟涨幅超过 2% 且窗口 CVD 为正",
"market":{"exchange":"binance","product":"spot","symbol":"XPLUSDT"},
"metrics":[{"name":"buy_notional_5m","kind":"window","stream":"aggTrade","window":"5m","filter":{"buyer_is_maker":false},"field":"notional","aggregation":"sum"},
{"name":"sell_notional_5m","kind":"window","stream":"aggTrade","window":"5m","filter":{"buyer_is_maker":true},"field":"notional","aggregation":"sum"},
{"name":"volume_delta_5m","kind":"combine","op":"diff","a":"buy_notional_5m","b":"sell_notional_5m"},
{"name":"return_5m","kind":"window","stream":"aggTrade","window":"5m","filter":{},"field":"price","aggregation":"return"}],
"condition":{"op":"and","conditions":[{"left":"return_5m","operator":">","right":{"value":0.02}},{"left":"volume_delta_5m","operator":">","right":{"value":0}}]},"cooldown_ms":10000},
"explanation":"基于 XPLUSDT aggTrade：最近 5 分钟价格收益率 (last-first)/first 超过 2%，且同窗口主动买入额 Σ(p×q | m=false) 减主动卖出额 Σ(p×q | m=true)（窗口 CVD）为正时触发。",
"assumptions":["CVD 按 5 分钟窗口计算，不是从启动起累计的绝对值","CVD 阈值取 0，成交清淡时可能在 0 附近翻转，可改为 USDT 绝对阈值"],"unsupported":null}

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
