/**
 * NotificationChannelRepository (Postgres) — CRUD for `notification_channels`.
 *
 * Postgres sibling of `sqlite/notification-channel.ts`. The `config` column
 * stores a JSON string with per-field encrypted secrets (see `StoredConfig`
 * below); the wire format is identical to the SQLite side so a backup/restore
 * across backends only needs to move rows, not transform them.
 */

import { sql, type SQL } from 'drizzle-orm';
import type { DbClient } from '../../db/client.js';
import type {
  INotificationChannelRepository,
  NotificationChannel,
  NewNotificationChannel,
  NotificationChannelPatch,
  NotificationChannelConfig,
  ListNotificationChannelsOptions,
  MaskOptions,
} from '@agentic-obs/common';
import {
  uid,
  nowIso,
  encryptSecret,
  decryptSecret,
  maskSecret,
} from '../sqlite/instance-shared.js';

interface ChannelRow {
  id: string;
  org_id: string | null;
  type: string;
  name: string;
  config: string;
  created_at: string;
  updated_at: string;
  updated_by: string | null;
}

type StoredConfig =
  | { kind: 'slack'; webhookUrlEnc: string | null }
  | { kind: 'pagerduty'; integrationKeyEnc: string | null }
  | {
      kind: 'email';
      host: string;
      port: number;
      username: string;
      passwordEnc: string | null;
      from: string;
    };

function encryptConfig(config: NotificationChannelConfig): StoredConfig {
  switch (config.kind) {
    case 'slack':
      return { kind: 'slack', webhookUrlEnc: encryptSecret(config.webhookUrl) };
    case 'pagerduty':
      return {
        kind: 'pagerduty',
        integrationKeyEnc: encryptSecret(config.integrationKey),
      };
    case 'email':
      return {
        kind: 'email',
        host: config.host,
        port: config.port,
        username: config.username,
        passwordEnc: encryptSecret(config.password),
        from: config.from,
      };
  }
}

function decryptConfig(stored: StoredConfig, masked: boolean): NotificationChannelConfig {
  switch (stored.kind) {
    case 'slack': {
      const plain = decryptSecret(stored.webhookUrlEnc) ?? '';
      return { kind: 'slack', webhookUrl: masked ? (maskSecret(plain) ?? '') : plain };
    }
    case 'pagerduty': {
      const plain = decryptSecret(stored.integrationKeyEnc) ?? '';
      return {
        kind: 'pagerduty',
        integrationKey: masked ? (maskSecret(plain) ?? '') : plain,
      };
    }
    case 'email': {
      const plain = decryptSecret(stored.passwordEnc) ?? '';
      return {
        kind: 'email',
        host: stored.host,
        port: stored.port,
        username: stored.username,
        password: masked ? (maskSecret(plain) ?? '') : plain,
        from: stored.from,
      };
    }
  }
}

function rowToChannel(r: ChannelRow, masked: boolean): NotificationChannel {
  const stored = JSON.parse(r.config) as StoredConfig;
  return {
    id: r.id,
    orgId: r.org_id,
    type: r.type as NotificationChannel['type'],
    name: r.name,
    config: decryptConfig(stored, masked),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    updatedBy: r.updated_by,
  };
}

export class PostgresNotificationChannelRepository
  implements INotificationChannelRepository
{
  constructor(private readonly db: DbClient) {}

  async list(
    opts: ListNotificationChannelsOptions = {},
  ): Promise<NotificationChannel[]> {
    const wheres: SQL[] = [];
    if (opts.orgId === null) {
      wheres.push(sql`org_id IS NULL`);
    } else if (typeof opts.orgId === 'string') {
      wheres.push(sql`org_id = ${opts.orgId}`);
    }
    if (opts.type) {
      wheres.push(sql`type = ${opts.type}`);
    }
    const whereClause = wheres.length
      ? sql.join([sql`WHERE`, sql.join(wheres, sql` AND `)], sql` `)
      : sql``;
    const result = await this.db.execute(sql`
      SELECT * FROM notification_channels ${whereClause}
      ORDER BY name
    `);
    const rows = result.rows as unknown as ChannelRow[];
    const masked = opts.masked ?? false;
    return rows.map((r) => rowToChannel(r, masked));
  }

  async get(id: string, opts: MaskOptions = {}): Promise<NotificationChannel | null> {
    const result = await this.db.execute(
      sql`SELECT * FROM notification_channels WHERE id = ${id}`,
    );
    const rows = result.rows as unknown as ChannelRow[];
    if (rows.length === 0) return null;
    return rowToChannel(rows[0]!, opts.masked ?? false);
  }

  async create(input: NewNotificationChannel): Promise<NotificationChannel> {
    const id = input.id ?? `${input.type}-${uid()}`;
    const now = nowIso();
    const stored = encryptConfig(input.config);
    await this.db.execute(sql`
      INSERT INTO notification_channels (
        id, org_id, type, name, config,
        created_at, updated_at, updated_by
      ) VALUES (
        ${id},
        ${input.orgId ?? null},
        ${input.type},
        ${input.name},
        ${JSON.stringify(stored)},
        ${now}, ${now},
        ${input.updatedBy ?? null}
      )
    `);
    const saved = await this.get(id);
    if (!saved) throw new Error(`[PostgresNotificationChannelRepository] create: row ${id} not found`);
    return saved;
  }

  async update(
    id: string,
    patch: NotificationChannelPatch,
  ): Promise<NotificationChannel | null> {
    const existing = await this.get(id);
    if (!existing) return null;
    const now = nowIso();
    const mergedName = patch.name ?? existing.name;
    const mergedConfig = patch.config ?? existing.config;
    const stored = encryptConfig(mergedConfig);
    const mergedUpdatedBy =
      patch.updatedBy !== undefined ? patch.updatedBy : existing.updatedBy;
    await this.db.execute(sql`
      UPDATE notification_channels SET
        name       = ${mergedName},
        config     = ${JSON.stringify(stored)},
        updated_at = ${now},
        updated_by = ${mergedUpdatedBy}
      WHERE id = ${id}
    `);
    return this.get(id);
  }

  async delete(id: string): Promise<boolean> {
    const before = await this.get(id);
    if (!before) return false;
    await this.db.execute(sql`DELETE FROM notification_channels WHERE id = ${id}`);
    return true;
  }
}
