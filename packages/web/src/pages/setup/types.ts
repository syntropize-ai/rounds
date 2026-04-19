// Types
//
// These are form-state shapes — all-strings, always-defined, friendly to
// controlled `<input>` React components. The **wire shapes** crossing the
// HTTP boundary (what routes like PUT /api/system/llm accept) live in
// `@agentic-obs/common/models/wire-config` so the frontend and backend
// share one definition of each request body. See T3.3 for the split.

// `LlmProvider` / `LlmAuthType` are imported from common so adding a new
// provider (e.g. `corporate-gateway`) is a one-edit change instead of a
// four-file change. Re-exported so existing consumers that import from
// this module keep working.
import type { LlmProvider, LlmAuthType } from '@agentic-obs/common';
export type { LlmProvider, LlmAuthType };

export interface ModelInfo {
  id: string;
  name: string;
  provider: string;
  description?: string;
}

/**
 * Form-state for the LLM wizard step. All fields are required strings
 * because controlled inputs dislike `undefined`. Converted to the optional
 * wire shape (`LlmConfigWire`) at submit time — empty strings become
 * `undefined` in the JSON request body.
 */
export interface LlmConfig {
  provider: LlmProvider;
  apiKey: string;
  model: string;
  baseUrl: string;
  region: string;
  authType: LlmAuthType;
}

export interface DatasourceEntry {
  // Stable id generated once per entry (on form open) and preserved across
  // edits. New rows POST to `/datasources`; edits PUT `/datasources/:id`.
  id: string;
  type: string;
  name: string;
  url: string;
  apiKey: string;
}

/**
 * Form-state for the notifications wizard step. Flattened per-channel so
 * each input has a dedicated state slot; converted to the nested
 * `NotificationsWire` shape at submit time.
 */
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

// DATASOURCE_TYPES lives in `../../constants/datasource-types.ts` — shared
// with the Settings page so the setup wizard and post-setup editor render
// the same picker.

export const STEPS = ['Welcome', 'Administrator', 'LLM Provider', 'Data Sources', 'Notifications', 'Ready'];
