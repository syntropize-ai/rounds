/**
 * Instance-scoped configuration models.
 *
 * Backed by the `instance_llm_config`, `notification_channels`, and
 * `instance_settings` tables. Replaces the legacy flat `setup-config.json`
 * file as the source of truth for LLM / notification config.
 *
 * Secret fields (apiKey, notification config secrets) are
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

/**
 * Wire format the corp-gateway's backend speaks. Determines which provider
 * implementation handles `complete()` and which endpoint URL pattern to use.
 * Only meaningful when `provider === 'corporate-gateway'`. For native
 * providers (anthropic / openai / etc.) this is implied by `provider`.
 */
export type LlmApiFormat =
  | 'anthropic'
  | 'openai'
  | 'gemini'
  | 'anthropic-bedrock';

export interface InstanceLlmConfig {
  provider: LlmProvider;
  apiKey?: string | null;
  model: string;
  baseUrl?: string | null;
  authType?: LlmAuthType | null;
  region?: string | null;
  /**
   * Optional shell command that prints a fresh API key on stdout. When set,
   * the gateway invokes it before each request (with a 5-min cache) and uses
   * the resulting key in place of the static `apiKey` field. Lets users plug
   * in `aws-vault exec ...`, `op read ...`, or any rotating-credential helper.
   */
  apiKeyHelper?: string | null;
  /**
   * For `corporate-gateway` only: which wire format the gateway's upstream
   * speaks. Backend dispatches to the matching provider implementation.
   */
  apiFormat?: LlmApiFormat | null;
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
  apiKeyHelper?: string | null;
  apiFormat?: LlmApiFormat | null;
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
