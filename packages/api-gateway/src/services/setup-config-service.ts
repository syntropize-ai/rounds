/**
 * SetupConfigService — one-stop owner of instance-scoped config reads and
 * writes (W2 / T2.4).
 *
 * Wraps the three new repositories (instance-config, datasources,
 * notification-channels), adds audit logging on mutations, and centralizes
 * the "is the instance fully bootstrapped" predicate.
 *
 * This replaces the `inMemoryConfig` + exported getter/setter pattern in
 * the old `routes/setup.ts`. All callers that previously imported
 * `getSetupConfig()` / `updateDatasources()` go through a service instance
 * passed via router deps.
 *
 * Design notes:
 *   - No caching. Every read hits SQLite — better-sqlite3 is synchronous
 *     and fast enough that an in-memory cache would add complexity for no
 *     measurable win, and correctness (e.g. "I just updated the api key
 *     but the next request saw the stale one") matters more than latency.
 *   - Encryption at rest is handled by the repository layer; the service
 *     deals in plaintext. Callers choose whether to mask on read via
 *     `{ masked: true }`.
 *   - Audit writes are fire-and-forget via `AuditWriter`.
 */

import type {
  IInstanceConfigRepository,
  IDatasourceRepository,
  INotificationChannelRepository,
  InstanceLlmConfig,
  NewInstanceLlmConfig,
  InstanceDatasource,
  NewInstanceDatasource,
  InstanceDatasourcePatch,
  NotificationChannel,
  NewNotificationChannel,
  NotificationChannelPatch,
  MaskOptions,
  ListDatasourcesOptions,
  ListNotificationChannelsOptions,
} from '@agentic-obs/common';
import { AuditAction } from '@agentic-obs/common';
import type { AuditWriter } from '../auth/audit-writer.js';

// Key names in `instance_settings`. Kept alongside the service so every
// caller uses the same constants.
export const INSTANCE_SETTING_KEYS = {
  bootstrappedAt: 'bootstrapped_at',
  configuredAt: 'configured_at',
} as const;

export interface SetupStatus {
  hasAdmin: boolean;
  hasLLM: boolean;
  datasourceCount: number;
  hasNotifications: boolean;
  bootstrappedAt: string | null;
  configuredAt: string | null;
}

export interface SetupConfigServiceDeps {
  instanceConfig: IInstanceConfigRepository;
  datasources: IDatasourceRepository;
  notificationChannels: INotificationChannelRepository;
  audit: AuditWriter;
}

export class SetupConfigService {
  constructor(private readonly deps: SetupConfigServiceDeps) {}

  // -- LLM -------------------------------------------------------------

  async getLlm(opts: MaskOptions = {}): Promise<InstanceLlmConfig | null> {
    return this.deps.instanceConfig.getLlm(opts);
  }

  async setLlm(
    input: NewInstanceLlmConfig,
    actor: { userId: string | null; orgId?: string | null },
  ): Promise<InstanceLlmConfig> {
    const saved = await this.deps.instanceConfig.setLlm({
      ...input,
      updatedBy: actor.userId,
    });
    void this.deps.audit.log({
      action: AuditAction.InstanceLlmUpdated,
      actorType: actor.userId ? 'user' : 'system',
      actorId: actor.userId ?? 'setup-wizard',
      targetType: 'instance_llm_config',
      targetId: 'singleton',
      outcome: 'success',
      metadata: {
        provider: saved.provider,
        model: saved.model,
        hasApiKey: !!saved.apiKey,
        hasBaseUrl: !!saved.baseUrl,
      },
    });
    return saved;
  }

  async clearLlm(actor: { userId: string | null }): Promise<boolean> {
    const removed = await this.deps.instanceConfig.clearLlm();
    if (removed) {
      void this.deps.audit.log({
        action: AuditAction.InstanceLlmCleared,
        actorType: actor.userId ? 'user' : 'system',
        actorId: actor.userId ?? 'setup-wizard',
        targetType: 'instance_llm_config',
        targetId: 'singleton',
        outcome: 'success',
      });
    }
    return removed;
  }

  // -- Datasources -----------------------------------------------------

  async listDatasources(opts: ListDatasourcesOptions = {}): Promise<InstanceDatasource[]> {
    return this.deps.datasources.list(opts);
  }

  async getDatasource(id: string, opts: MaskOptions = {}): Promise<InstanceDatasource | null> {
    return this.deps.datasources.get(id, opts);
  }

  async createDatasource(
    input: NewInstanceDatasource,
    actor: { userId: string | null },
  ): Promise<InstanceDatasource> {
    const ds = await this.deps.datasources.create({ ...input, updatedBy: actor.userId });
    void this.deps.audit.log({
      action: AuditAction.DatasourceCreated,
      actorType: actor.userId ? 'user' : 'system',
      actorId: actor.userId ?? 'setup-wizard',
      targetType: 'datasource',
      targetId: ds.id,
      outcome: 'success',
      metadata: { type: ds.type, name: ds.name, orgId: ds.orgId },
    });
    return ds;
  }

  async updateDatasource(
    id: string,
    patch: InstanceDatasourcePatch,
    actor: { userId: string | null },
  ): Promise<InstanceDatasource | null> {
    const updated = await this.deps.datasources.update(id, {
      ...patch,
      updatedBy: actor.userId,
    });
    if (updated) {
      void this.deps.audit.log({
        action: AuditAction.DatasourceUpdated,
        actorType: actor.userId ? 'user' : 'system',
        actorId: actor.userId ?? 'setup-wizard',
        targetType: 'datasource',
        targetId: id,
        outcome: 'success',
        metadata: { type: updated.type, name: updated.name },
      });
    }
    return updated;
  }

  async deleteDatasource(
    id: string,
    actor: { userId: string | null },
  ): Promise<boolean> {
    const removed = await this.deps.datasources.delete(id);
    if (removed) {
      void this.deps.audit.log({
        action: AuditAction.DatasourceDeleted,
        actorType: actor.userId ? 'user' : 'system',
        actorId: actor.userId ?? 'setup-wizard',
        targetType: 'datasource',
        targetId: id,
        outcome: 'success',
      });
    }
    return removed;
  }

  async countDatasources(orgId?: string | null): Promise<number> {
    return this.deps.datasources.count(orgId);
  }

  // -- Notification channels ------------------------------------------

  async listNotificationChannels(
    opts: ListNotificationChannelsOptions = {},
  ): Promise<NotificationChannel[]> {
    return this.deps.notificationChannels.list(opts);
  }

  async getNotificationChannel(id: string, opts: MaskOptions = {}) {
    return this.deps.notificationChannels.get(id, opts);
  }

  async createNotificationChannel(
    input: NewNotificationChannel,
    actor: { userId: string | null },
  ): Promise<NotificationChannel> {
    const ch = await this.deps.notificationChannels.create({
      ...input,
      updatedBy: actor.userId,
    });
    void this.deps.audit.log({
      action: AuditAction.NotificationChannelCreated,
      actorType: actor.userId ? 'user' : 'system',
      actorId: actor.userId ?? 'setup-wizard',
      targetType: 'notification_channel',
      targetId: ch.id,
      outcome: 'success',
      metadata: { type: ch.type, name: ch.name, orgId: ch.orgId },
    });
    return ch;
  }

  async updateNotificationChannel(
    id: string,
    patch: NotificationChannelPatch,
    actor: { userId: string | null },
  ): Promise<NotificationChannel | null> {
    const updated = await this.deps.notificationChannels.update(id, {
      ...patch,
      updatedBy: actor.userId,
    });
    if (updated) {
      void this.deps.audit.log({
        action: AuditAction.NotificationChannelUpdated,
        actorType: actor.userId ? 'user' : 'system',
        actorId: actor.userId ?? 'setup-wizard',
        targetType: 'notification_channel',
        targetId: id,
        outcome: 'success',
      });
    }
    return updated;
  }

  async deleteNotificationChannel(
    id: string,
    actor: { userId: string | null },
  ): Promise<boolean> {
    const removed = await this.deps.notificationChannels.delete(id);
    if (removed) {
      void this.deps.audit.log({
        action: AuditAction.NotificationChannelDeleted,
        actorType: actor.userId ? 'user' : 'system',
        actorId: actor.userId ?? 'setup-wizard',
        targetType: 'notification_channel',
        targetId: id,
        outcome: 'success',
      });
    }
    return removed;
  }

  // -- Bootstrap marker + status -------------------------------------

  /**
   * Idempotent: only writes the bootstrap timestamp if it's unset.
   * Returns the value that's now persisted.
   */
  async markBootstrapped(at: string = new Date().toISOString()): Promise<string> {
    const existing = await this.deps.instanceConfig.getSetting(
      INSTANCE_SETTING_KEYS.bootstrappedAt,
    );
    if (existing) return existing;
    await this.deps.instanceConfig.setSetting(
      INSTANCE_SETTING_KEYS.bootstrappedAt,
      at,
    );
    void this.deps.audit.log({
      action: AuditAction.InstanceBootstrapped,
      actorType: 'system',
      actorId: 'setup-wizard',
      targetType: 'instance_settings',
      targetId: INSTANCE_SETTING_KEYS.bootstrappedAt,
      outcome: 'success',
      metadata: { bootstrappedAt: at },
    });
    return at;
  }

  async getBootstrappedAt(): Promise<string | null> {
    return this.deps.instanceConfig.getSetting(INSTANCE_SETTING_KEYS.bootstrappedAt);
  }

  async isBootstrapped(): Promise<boolean> {
    return (await this.getBootstrappedAt()) !== null;
  }

  async setConfiguredAt(at: string = new Date().toISOString()): Promise<void> {
    await this.deps.instanceConfig.setSetting(
      INSTANCE_SETTING_KEYS.configuredAt,
      at,
    );
  }

  async getConfiguredAt(): Promise<string | null> {
    return this.deps.instanceConfig.getSetting(INSTANCE_SETTING_KEYS.configuredAt);
  }

  /**
   * High-level readiness view used by `GET /api/setup/status`. `hasAdmin`
   * must be provided externally (the service doesn't own user state).
   */
  async getStatus(hasAdmin: boolean): Promise<SetupStatus> {
    const [llm, datasourceCount, channels, bootstrappedAt, configuredAt] =
      await Promise.all([
        this.deps.instanceConfig.getLlm({ masked: true }),
        this.deps.datasources.count(),
        this.deps.notificationChannels.list(),
        this.getBootstrappedAt(),
        this.getConfiguredAt(),
      ]);
    return {
      hasAdmin,
      hasLLM: !!llm,
      datasourceCount,
      hasNotifications: channels.length > 0,
      bootstrappedAt,
      configuredAt,
    };
  }
}
