import type { LlmConfig } from './nl/parse.ts';

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
  // 每 IP 每分钟次数：parse 每次都调用 LLM（计费），webhook test 每次都对外发请求
  parseRateLimit: Number(env.PARSE_RATE_LIMIT ?? 20),
  webhookTestRateLimit: Number(env.WEBHOOK_TEST_RATE_LIMIT ?? 10),
  metricRetentionDays: Number(env.METRIC_RETENTION_DAYS ?? 7),
  llm: (llmKey && llmBase ? { baseUrl: llmBase, apiKey: llmKey, model: env.LLM_MODEL || 'MiniMax-M2' } : null) as LlmConfig | null,
  production: env.NODE_ENV === 'production',
};
