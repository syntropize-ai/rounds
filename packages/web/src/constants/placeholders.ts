/**
 * Default URL placeholders shown in "Add datasource" and LLM configuration inputs.
 * These are display-only hints — the user always types their real URL into the
 * field. Centralized here so it's clear where to update them when a default port
 * changes or a new backend is added.
 */

export const DATASOURCE_URL_PLACEHOLDER: Record<string, string> = {
  prometheus: 'http://localhost:9090',
  'victoria-metrics': 'http://localhost:8428',
  loki: 'http://localhost:3100',
  tempo: 'http://localhost:3200',
  jaeger: 'http://localhost:16686',
  elasticsearch: 'http://localhost:9200',
  clickhouse: 'http://localhost:8123',
  otel: 'http://localhost:4318',
};

export const LLM_BASE_URL_PLACEHOLDER: Record<string, string> = {
  ollama: 'http://localhost:11434',
  azure: 'https://your-resource.openai.azure.com',
  // OpenAI itself defaults to the official API; left blank uses
  // https://api.openai.com/v1. Set this to point at any OpenAI-compatible
  // endpoint — OpenRouter (https://openrouter.ai/api/v1), Together AI,
  // Groq (https://api.groq.com/openai/v1), DeepSeek, etc.
  openai: 'https://api.openai.com/v1 (leave blank) or https://openrouter.ai/api/v1',
  deepseek: 'https://api.deepseek.com/v1',
};

export function datasourceUrlPlaceholder(type: string): string {
  return DATASOURCE_URL_PLACEHOLDER[type] ?? 'http://localhost';
}

export function llmBaseUrlPlaceholder(provider: string): string {
  return LLM_BASE_URL_PLACEHOLDER[provider] ?? '';
}
