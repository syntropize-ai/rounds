/**
 * Repository interfaces for instance-scoped config (Wave 2 / T2.2).
 *
 * Implementations live in `packages/data-layer/src/repository/sqlite/`:
 *   - instance-config.ts       (InstanceConfigRepository)
 *   - datasource.ts            (DatasourceRepository)
 *   - notification-channel.ts  (NotificationChannelRepository)
 *
 * Secret fields (api_key, password, notification secrets) are encrypted
 * on write and decrypted on read by the repository using AES-256-GCM
 * with SECRET_KEY from env. Callers pass `{ masked: true }` to receive
 * redacted values suitable for UI (e.g. "••••••abcd").
 */

import type {
  InstanceLlmConfig,
  NewInstanceLlmConfig,
  InstanceDatasource,
  NewInstanceDatasource,
  InstanceDatasourcePatch,
  NotificationChannel,
  NewNotificationChannel,
  NotificationChannelPatch,
} from '../../models/instance-config.js';

/**
 * Read options common to secret-holding repositories. When `masked` is
 * true, returned objects have their secret fields replaced with a
 * fixed-length bullet sequence (or bullets + last-4) — never the
 * plaintext. Use `masked: true` for any response that leaves the
 * server; keep the default (`false`) for internal consumers that need
 * the real value (e.g. the query proxy building Authorization headers).
 */
export interface MaskOptions {
  masked?: boolean;
}

// -- InstanceConfigRepository -----------------------------------------

export interface IInstanceConfigRepository {
  /** Read the singleton LLM config row. Returns null when no LLM is configured. */
  getLlm(opts?: MaskOptions): Promise<InstanceLlmConfig | null>;
  /** Upsert the singleton LLM config row. */
  setLlm(input: NewInstanceLlmConfig): Promise<InstanceLlmConfig>;
  /** Delete the singleton LLM config row. Returns true if a row was deleted. */
  clearLlm(): Promise<boolean>;

  /** Read a value from instance_settings. Returns null if unset. */
  getSetting(key: string): Promise<string | null>;
  /** Upsert a value in instance_settings. */
  setSetting(key: string, value: string): Promise<void>;
  /** Delete a key from instance_settings. Returns true if a row was deleted. */
  deleteSetting(key: string): Promise<boolean>;
}

// -- DatasourceRepository ---------------------------------------------

export interface ListDatasourcesOptions extends MaskOptions {
  /**
   * Filter by org_id. When undefined, returns all datasources (both
   * instance-global, org_id IS NULL, and any per-org rows). Pass `null`
   * explicitly to fetch only instance-global rows; pass a string to
   * fetch only that org's rows.
   */
  orgId?: string | null;
  type?: string;
}

export interface IDatasourceRepository {
  list(opts?: ListDatasourcesOptions): Promise<InstanceDatasource[]>;
  get(id: string, opts?: MaskOptions): Promise<InstanceDatasource | null>;
  create(input: NewInstanceDatasource): Promise<InstanceDatasource>;
  update(id: string, patch: InstanceDatasourcePatch): Promise<InstanceDatasource | null>;
  delete(id: string): Promise<boolean>;
  count(orgId?: string | null): Promise<number>;
}

// -- NotificationChannelRepository ------------------------------------

export interface ListNotificationChannelsOptions extends MaskOptions {
  orgId?: string | null;
  type?: string;
}

export interface INotificationChannelRepository {
  list(opts?: ListNotificationChannelsOptions): Promise<NotificationChannel[]>;
  get(id: string, opts?: MaskOptions): Promise<NotificationChannel | null>;
  create(input: NewNotificationChannel): Promise<NotificationChannel>;
  update(id: string, patch: NotificationChannelPatch): Promise<NotificationChannel | null>;
  delete(id: string): Promise<boolean>;
}
