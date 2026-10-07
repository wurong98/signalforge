/**
 * OpenAI 兼容 /chat/completions 调用（parse.ts 与 chat.ts 共用）。
 * 只在 nl/ 内使用；engine/ 不得 import（AGENTS.md 不变量 1）。
 */

export interface LlmConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  /**
   * 端点是否认识 DeepSeek 的 `thinking` 参数。OpenAI 等端点会拒绝未知参数，
   * 所以只有为 true 时才发送；默认按 baseUrl 是否为 deepseek.com 推断。
   */
  thinkingParam?: boolean;
}

export interface LlmMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: LlmToolCall[];
  tool_call_id?: string;
}

export interface LlmToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export interface LlmTool {
  type: 'function';
  function: { name: string; description: string; parameters: unknown };
}

export interface LlmOptions {
  /**
   * DeepSeek 思考模式。按用途分开（docs/llm-assistant-plan.md §11）：
   * 生成 DSL 开（单次调用、无工具，reasoning_content 无需回传）；
   * 对话工具循环关（带工具时开启思考必须逐轮回传 reasoning_content，否则 400）。
   */
  thinking?: boolean;
  temperature?: number;
  tools?: LlmTool[];
  timeoutMs?: number;
  signal?: AbortSignal;
}

/** 请求体单独构造，便于测试参数是否按端点能力发送 */
export function buildRequestBody(cfg: LlmConfig, messages: LlmMessage[], opts: LlmOptions = {}) {
  const body: Record<string, unknown> = { model: cfg.model, messages };
  if (opts.temperature !== undefined) body.temperature = opts.temperature;
  if (opts.tools?.length) body.tools = opts.tools;
  if (opts.thinking !== undefined && cfg.thinkingParam) body.thinking = { type: opts.thinking ? 'enabled' : 'disabled' };
  return body;
}

export type LlmCall = (messages: LlmMessage[], opts?: LlmOptions) => Promise<LlmMessage>;

export function llmCaller(cfg: LlmConfig): LlmCall {
  return async (messages, opts = {}) => {
    const timeout = AbortSignal.timeout(opts.timeoutMs ?? 60_000);
    const res = await fetch(`${cfg.baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${cfg.apiKey}` },
      body: JSON.stringify(buildRequestBody(cfg, messages, opts)),
      signal: opts.signal ? AbortSignal.any([timeout, opts.signal]) : timeout,
    });
    if (!res.ok) throw new Error(`LLM HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const data: any = await res.json();
    const msg = data?.choices?.[0]?.message;
    if (!msg || (typeof msg.content !== 'string' && !Array.isArray(msg.tool_calls))) throw new Error('LLM returned no content');
    return {
      role: 'assistant',
      content: typeof msg.content === 'string' ? msg.content : null,
      ...(Array.isArray(msg.tool_calls) && msg.tool_calls.length ? { tool_calls: msg.tool_calls } : {}),
    };
  };
}

/** 去掉推理模型内联的 <think> 块 */
export function stripThink(text: string): string {
  return text.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
}
