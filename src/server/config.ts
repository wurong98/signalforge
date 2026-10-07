import type { LlmConfig } from './nl/llm.ts';

const env = process.env;

const llmKey = env.LLM_API_KEY || env.OPENAI_API_KEY || '';
const llmBase = env.LLM_BASE_URL || env.OPENAI_BASE_URL || '';

export const config = {
  port: Number(env.PORT ?? 8787),
  host: env.HOST ?? '127.0.0.1',
  dbPath: env.DB_PATH ?? './data/signalforge.db',
  // 管理密码哈希文件；忘记密码时删除它，下次打开页面重新设置
  adminFile: env.ADMIN_FILE ?? './data/admin.json',
  binanceWs: env.BINANCE_WS_URL ?? 'wss://stream.binance.com:9443',
  binanceRest: env.BINANCE_REST_URL ?? 'https://api.binance.com',
  symbols: (env.SYMBOLS ?? 'BTCUSDT').split(',').map((s) => s.trim().toUpperCase()).filter(Boolean),
  allowPrivateWebhooks: env.ALLOW_PRIVATE_WEBHOOKS === 'true',
  metricRetentionDays: Number(env.METRIC_RETENTION_DAYS ?? 7),
  llm: (llmKey && llmBase
    ? {
        baseUrl: llmBase,
        apiKey: llmKey,
        model: env.LLM_MODEL || 'deepseek-flash',
        // 只有 DeepSeek 认识 thinking 参数；其他 OpenAI 兼容端点可能因未知参数报错
        thinkingParam: env.LLM_THINKING_PARAM ? env.LLM_THINKING_PARAM === 'true' : /deepseek\.com/.test(llmBase),
      }
    : null) as LlmConfig | null,
  production: env.NODE_ENV === 'production',
};
