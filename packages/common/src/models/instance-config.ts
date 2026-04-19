/**
 * Instance-scoped configuration models.
 *
 * Backed by the `instance_llm_config`, `instance_datasources`,
 * `notification_channels`, and `instance_settings` tables added in
 * migration 019. Replaces the legacy flat `setup-config.json` file as
 * the source of truth for LLM / datasource / notification config.
 *
 * Secret fields (apiKey, password, notification config secrets) are
 * stored encrypted at rest via AES-256-GCM with `SECRET_KEY` (see
 * `@agentic-obs/common/crypto`). Repository reads return plaintext;
 * callers pass `{ masked: true }` to receive redacted values for UI.
 */

// -- LLM ---------------------------------------------------------------

export type LlmProvider =
  | 'anthropic'
  | 'openai'
  | 'deepseek'
  | 'azure-openai'
  | 'aws-bedrock'
  | 'ollama'
  | 'gemini'
  | 'corporate-gateway';

export type LlmAuthType = 'api-key' | 'bearer';

export interface InstanceLlmConfig {
  provider: LlmProvider;
  apiKey?: string | null;
  model: string;
  baseUrl?: string | null;
  authType?: LlmAuthType | null;
  region?: string | null;
  updatedAt: string;
  updatedBy?: string | null;
}

export interface NewInstanceLlmConfig {
  provider: LlmProvider;
  apiKey?: string | null;
  model: string;
  baseUrl?: string | null;
  authType?: LlmAuthType | null;
  region?: string | null;
  updatedBy?: string | null;
}

// -- Datasource --------------------------------------------------------

export type DatasourceType =
  | 'loki'
  | 'elasticsearch'
  | 'clickhouse'
  | 'tempo'
  | 'jaeger'
  | 'otel'
  | 'prometheus'
  | 'victoria-metrics';

export interface InstanceDatasource {
  id: string;
  orgId: string | null;
  type: DatasourceType;
  name: string;
  url: string;
  environment?: string | null;
  cluster?: string | null;
  label?: string | null;
  isDefault: boolean;
  apiKey?: string | null;
  username?: string | null;
  password?: string | null;
  createdAt: string;
  updatedAt: string;
  updatedBy?: string | null;
}

export interface NewInstanceDatasource {
  id?: string;
  orgId?: string | null;
  type: DatasourceType;
  name: string;
  url: string;
  environment?: string | null;
  cluster?: string | null;
  label?: string | null;
  isDefault?: boolean;
  apiKey?: string | null;
  username?: string | null;
  password?: string | null;
  updatedBy?: string | null;
}

export interface InstanceDatasourcePatch {
  type?: DatasourceType;
  name?: string;
  url?: string;
  environment?: string | null;
  cluster?: string | null;
  label?: string | null;
  isDefault?: boolean;
  apiKey?: string | null;
  username?: string | null;
  password?: string | null;
  updatedBy?: string | null;
}

// -- Notification channel ---------------------------------------------

export type NotificationChannelType = 'slack' | 'pagerduty' | 'email';

/**
 * Slack/PagerDuty/email notification config.
 *
 * All fields of each variant go into a single JSON blob on disk. Secret
 * fields are encrypted individually before the blob is serialized; the
 * shape returned from repositories is plaintext. The `kind` discriminator
 * mirrors `NotificationChannel.type`.
 */
export type NotificationChannelConfig =
  | { kind: 'slack'; webhookUrl: string }
  | { kind: 'pagerduty'; integrationKey: string }
  | {
      kind: 'email';
      host: string;
      port: number;
      username: string;
      password: string;
      from: string;
    };

export interface NotificationChannel {
  id: string;
  orgId: string | null;
  type: NotificationChannelType;
  name: string;
  config: NotificationChannelConfig;
  createdAt: string;
  updatedAt: string;
  updatedBy?: string | null;
}

export interface NewNotificationChannel {
  id?: string;
  orgId?: string | null;
  type: NotificationChannelType;
  name: string;
  config: NotificationChannelConfig;
  updatedBy?: string | null;
}

export interface NotificationChannelPatch {
  name?: string;
  config?: NotificationChannelConfig;
  updatedBy?: string | null;
}

// -- Instance settings KV ---------------------------------------------

/** Keys we know about. Other keys are allowed but these are the reserved set. */
export type InstanceSettingKey =
  | 'bootstrapped_at'
  | 'configured_at'
  | (string & Record<never, never>);
