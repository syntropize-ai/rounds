/**
 * SqliteGithubAppConfigRepository — stores per-org GitHub App credentials
 * obtained from the App Manifest flow. Encryption uses the shared
 * `encryptSecret`/`decryptSecret` helpers (AES-256-GCM with SECRET_KEY).
 */

import { sql } from 'drizzle-orm';
import type { SqliteClient } from '../../db/sqlite-client.js';
import {
  encryptSecret,
  decryptSecret,
  nowIso,
} from './instance-shared.js';
import type {
  GithubAppConfig,
  IGithubAppConfigRepository,
  NewGithubAppConfig,
} from '../types/github-app-config.js';

interface Row {
  org_id: string;
  app_id: number;
  slug: string;
  client_id: string;
  client_secret_ciphertext: string;
  private_key_ciphertext: string;
  webhook_secret_ciphertext: string | null;
  registered_at: string;
  registered_by: string;
}

function rowToConfig(r: Row): GithubAppConfig {
  const clientSecret = decryptSecret(r.client_secret_ciphertext);
  const privateKey = decryptSecret(r.private_key_ciphertext);
  if (clientSecret === null || privateKey === null) {
    throw new Error('[GithubAppConfigRepository] missing required ciphertext columns');
  }
  return {
    orgId: r.org_id,
    appId: r.app_id,
    slug: r.slug,
    clientId: r.client_id,
    clientSecret,
    privateKey,
    webhookSecret: decryptSecret(r.webhook_secret_ciphertext),
    registeredAt: r.registered_at,
    registeredBy: r.registered_by,
  };
}

export class SqliteGithubAppConfigRepository implements IGithubAppConfigRepository {
  constructor(private readonly db: SqliteClient) {}

  async get(orgId: string): Promise<GithubAppConfig | null> {
    const rows = this.db.all<Row>(
      sql`SELECT * FROM github_app_config WHERE org_id = ${orgId} LIMIT 1`,
    );
    return rows.length === 0 ? null : rowToConfig(rows[0]!);
  }

  async insert(input: NewGithubAppConfig): Promise<GithubAppConfig> {
    const registeredAt = nowIso();
    const clientSecretCt = encryptSecret(input.clientSecret);
    const privateKeyCt = encryptSecret(input.privateKey);
    const webhookSecretCt = encryptSecret(input.webhookSecret ?? null);
    if (clientSecretCt === null || privateKeyCt === null) {
      throw new Error('[GithubAppConfigRepository] clientSecret and privateKey are required');
    }
    this.db.run(sql`
      INSERT INTO github_app_config (
        org_id, app_id, slug, client_id,
        client_secret_ciphertext, private_key_ciphertext, webhook_secret_ciphertext,
        registered_at, registered_by
      ) VALUES (
        ${input.orgId}, ${input.appId}, ${input.slug}, ${input.clientId},
        ${clientSecretCt}, ${privateKeyCt}, ${webhookSecretCt},
        ${registeredAt}, ${input.registeredBy}
      )
      ON CONFLICT(org_id) DO UPDATE SET
        app_id                     = excluded.app_id,
        slug                       = excluded.slug,
        client_id                  = excluded.client_id,
        client_secret_ciphertext   = excluded.client_secret_ciphertext,
        private_key_ciphertext     = excluded.private_key_ciphertext,
        webhook_secret_ciphertext  = excluded.webhook_secret_ciphertext,
        registered_at              = excluded.registered_at,
        registered_by              = excluded.registered_by
    `);
    const saved = await this.get(input.orgId);
    if (!saved) throw new Error('[GithubAppConfigRepository] insert did not produce a row');
    return saved;
  }

  async delete(orgId: string): Promise<boolean> {
    const before = await this.get(orgId);
    if (!before) return false;
    this.db.run(sql`DELETE FROM github_app_config WHERE org_id = ${orgId}`);
    return true;
  }
}
