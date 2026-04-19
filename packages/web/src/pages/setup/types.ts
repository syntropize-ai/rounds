// Types

export type LlmProvider =
  | 'anthropic'
  | 'openai'
  | 'gemini'
  | 'deepseek'
  | 'azure-openai'
  | 'aws-bedrock'
  | 'ollama'
  | 'corporate-gateway';

export interface ModelInfo {
  id: string;
  name: string;
  provider: string;
  description?: string;
}

export interface LlmConfig {
  provider: LlmProvider;
  apiKey: string;
  model: string;
  baseUrl: string;
  region: string;
  authType: string;
}

export interface DatasourceEntry {
  // Stable id generated once per entry (on form open) and preserved across
  // edits, so POST /setup/datasource upserts instead of appending duplicates.
  id: string;
  type: string;
  name: string;
  url: string;
  apiKey: string;
}

export interface NotificationConfig {
  slackWebhook: string;
  pagerDutyKey: string;
  emailHost: string;
  emailPort: string;
  emailUser: string;
  emailPass: string;
  emailFrom: string;
}

// Provider metadata

export const LLM_PROVIDERS: Array<{
  value: LlmProvider;
  label: string;
  fallbackModels: string[];
  needsKey: boolean;
  needsUrl?: boolean;
  needsRegion?: boolean;
  supportsModelFetch?: boolean;
}> = [
  {
    value: 'anthropic',
    label: 'Anthropic (Claude)',
    fallbackModels: ['claude-opus-4-5', 'claude-sonnet-4-5', 'claude-haiku-4-5'],
    needsKey: true,
    supportsModelFetch: true,
  },
  {
    value: 'openai',
    label: 'OpenAI',
    fallbackModels: ['gpt-4o', 'gpt-4o-mini', 'gpt-4-turbo'],
    needsKey: true,
    supportsModelFetch: true,
  },
  {
    value: 'gemini',
    label: 'Google Gemini',
    fallbackModels: ['gemini-2.5-flash', 'gemini-2.5-pro'],
    needsKey: true,
    supportsModelFetch: true,
  },
  {
    value: 'deepseek',
    label: 'DeepSeek',
    fallbackModels: ['deepseek-chat', 'deepseek-reasoner'],
    needsKey: true,
    supportsModelFetch: true,
  },
  {
    value: 'azure-openai',
    label: 'Azure OpenAI',
    fallbackModels: ['gpt-4o', 'gpt-4-turbo'],
    needsKey: true,
    needsUrl: true,
  },
  {
    value: 'aws-bedrock',
    label: 'AWS Bedrock',
    fallbackModels: ['anthropic.claude-3-5-sonnet-20241022-v2:0', 'amazon.nova-pro-v1:0'],
    needsKey: false,
    needsRegion: true,
  },
  {
    value: 'ollama',
    label: 'Local (Ollama / Llama)',
    fallbackModels: ['llama3.2', 'mistral', 'gemma2'],
    needsKey: false,
    needsUrl: true,
    supportsModelFetch: true,
  },
  {
    value: 'corporate-gateway',
    label: 'Corporate Gateway (Okta/SSO)',
    fallbackModels: ['claude-sonnet-4-6', 'claude-opus-4-6', 'claude-haiku-4-5'],
    needsKey: true,
    needsUrl: true,
  },
];

// `supported: false` = backend has no adapter wired yet. The entry still
// appears in the picker but disabled, so the UI is honest about what the
// running product can do. Flip to true as adapters land.
export const DATASOURCE_TYPES: Array<{
  value: string;
  label: string;
  category: 'Logs' | 'Traces' | 'Metrics';
  supported: boolean;
}> = [
  { value: 'prometheus',       label: 'Prometheus',       category: 'Metrics', supported: true  },
  { value: 'victoria-metrics', label: 'VictoriaMetrics',  category: 'Metrics', supported: true  },
  { value: 'loki',             label: 'Loki',             category: 'Logs',    supported: false },
  { value: 'elasticsearch',    label: 'Elasticsearch',    category: 'Logs',    supported: false },
  { value: 'clickhouse',       label: 'ClickHouse',       category: 'Logs',    supported: false },
  { value: 'tempo',            label: 'Tempo',            category: 'Traces',  supported: false },
  { value: 'jaeger',           label: 'Jaeger',           category: 'Traces',  supported: false },
  { value: 'otel',             label: 'OTel Collector',   category: 'Traces',  supported: false },
];

export const STEPS = ['Welcome', 'Administrator', 'LLM Provider', 'Data Sources', 'Notifications', 'Ready'];
