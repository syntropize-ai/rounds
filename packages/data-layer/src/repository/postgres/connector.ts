import { sql, type SQL } from 'drizzle-orm';
import type { QueryClient } from '../../db/query-client.js';
import type {
  Connector,
  ConnectorConfig,
  ConnectorLookupOptions,
  ConnectorPatch,
  ConnectorPolicyScope,
  ConnectorSecret,
  ConnectorStatus,
  ConnectorTeamPolicy,
  ConnectorType,
  ListConnectorPoliciesOptions,
  ListConnectorsOptions,
  NewConnector,
  UpsertConnectorSecret,
  UpsertConnectorTeamPolicy,
} from '@agentic-obs/common';
import type { IConnectorRepository } from '../types/connector.js';
import {
  capabilitiesForType,
  nowIso,
  parseJson,
  stringifyJson,
  typeMatchesCategory,
  uid,
} from '../connector-shared.js';
import { pgAll, pgRun } from './pg-helpers.js';

interface ConnectorRow {
  id: string;
  org_id: string;
  type: string;
  name: string;
  config: ConnectorConfig | string;
  status: string;
  last_verified_at: string | Date | null;
  last_verify_error: string | null;
  is_default: boolean;
  created_by: string;
  created_at: string | Date;
  updated_at: string | Date;
  capabilities: string[] | string | null;
  secret_connector_id: string | null;
}

interface ConnectorSecretRow {
  connector_id: string;
  ciphertext: Uint8Array;
  key_version: number;
  created_at: string | Date;
  updated_at: string | Date;
}

interface ConnectorPolicyRow {
  connector_id: string;
  team_id: string;
  capability: string;
  scope: ConnectorPolicyScope | string | null;
  human_policy: string;
  agent_policy: string;
}

function rowToConnector(row: ConnectorRow): Connector {
  const capabilities = parseJson<string[]>(row.capabilities, []);
  const type = row.type as ConnectorType;
  return {
    id: row.id,
    orgId: row.org_id,
    type,
    name: row.name,
    config: parseJson<ConnectorConfig>(row.config, {}),
    status: row.status as ConnectorStatus,
    lastVerifiedAt: timestampToString(row.last_verified_at),
    lastVerifyError: row.last_verify_error,
    isDefault: row.is_default,
    createdBy: row.created_by,
    createdAt: timestampToString(row.created_at)!,
    updatedAt: timestampToString(row.updated_at)!,
    capabilities,
    secretMissing: row.secret_connector_id === null,
    defaultFor: row.is_default ? type : null,
  };
}

function rowToSecret(row: ConnectorSecretRow): ConnectorSecret {
  return {
    connectorId: row.connector_id,
    ciphertext: row.ciphertext,
    keyVersion: row.key_version,
    createdAt: timestampToString(row.created_at)!,
    updatedAt: timestampToString(row.updated_at)!,
  };
}

function timestampToString(value: string | Date | null): string | null {
  if (value === null) return null;
  return value instanceof Date ? value.toISOString() : value;
}

function rowToPolicy(row: ConnectorPolicyRow): ConnectorTeamPolicy {
  return {
    connectorId: row.connector_id,
    teamId: row.team_id,
    capability: row.capability,
    scope: parseJson<ConnectorPolicyScope | null>(row.scope, null),
    humanPolicy: row.human_policy as ConnectorTeamPolicy['humanPolicy'],
    agentPolicy: row.agent_policy as ConnectorTeamPolicy['agentPolicy'],
  };
}

export class PostgresConnectorRepository implements IConnectorRepository {
  constructor(private readonly db: QueryClient) {}

  async list(opts: ListConnectorsOptions): Promise<Connector[]> {
    const wheres: SQL[] = [sql`c.org_id = ${opts.orgId}`];
    if (opts.type) wheres.push(sql`c.type = ${opts.type}`);
    if (opts.status) wheres.push(sql`c.status = ${opts.status}`);
    if (opts.capability) wheres.push(sql`cc_filter.capability = ${opts.capability}`);
    const capabilityJoin = opts.capability
      ? sql`INNER JOIN connector_capabilities cc_filter ON cc_filter.connector_id = c.id`
      : sql``;

    const rows = await pgAll<ConnectorRow>(this.db, sql`
      SELECT c.*,
        COALESCE(
          json_agg(cc.capability) FILTER (WHERE cc.capability IS NOT NULL),
          '[]'::json
        ) AS capabilities,
        s.connector_id AS secret_connector_id
      FROM connectors c
      ${capabilityJoin}
      LEFT JOIN connector_capabilities cc ON cc.connector_id = c.id
      LEFT JOIN connector_secrets s ON s.connector_id = c.id
      WHERE ${sql.join(wheres, sql` AND `)}
      GROUP BY c.id, s.connector_id
      ORDER BY c.name
    `);

    return rows
      .map(rowToConnector)
      .filter((connector) => typeMatchesCategory(connector.type, opts.category));
  }

  async get(id: string, opts: ConnectorLookupOptions): Promise<Connector | null> {
    const rows = await pgAll<ConnectorRow>(this.db, sql`
      SELECT c.*,
        COALESCE(
          json_agg(cc.capability) FILTER (WHERE cc.capability IS NOT NULL),
          '[]'::json
        ) AS capabilities,
        s.connector_id AS secret_connector_id
      FROM connectors c
      LEFT JOIN connector_capabilities cc ON cc.connector_id = c.id
      LEFT JOIN connector_secrets s ON s.connector_id = c.id
      WHERE c.id = ${id} AND c.org_id = ${opts.orgId}
      GROUP BY c.id, s.connector_id
    `);
    return rows[0] ? rowToConnector(rows[0]) : null;
  }

  async create(input: NewConnector): Promise<Connector> {
    const id = input.id ?? `${input.type}-${uid()}`;
    const now = nowIso();
    const capabilities = capabilitiesForType(input.type);
    await this.db.withTransaction(async (tx) => {
      if (input.isDefault) {
        await tx.run(sql`
          UPDATE connectors
          SET is_default = FALSE, updated_at = ${now}
          WHERE org_id = ${input.orgId} AND type = ${input.type} AND is_default = TRUE
        `);
      }
      await tx.run(sql`
        INSERT INTO connectors (
          id, org_id, type, name, config, status, last_verified_at,
          last_verify_error, is_default, created_by, created_at, updated_at
        ) VALUES (
          ${id}, ${input.orgId}, ${input.type}, ${input.name},
          ${JSON.stringify(input.config ?? {})}::jsonb,
          ${input.status ?? 'draft'},
          ${input.lastVerifiedAt ?? null},
          ${input.lastVerifyError ?? null},
          ${input.isDefault ?? false},
          ${input.createdBy},
          ${now},
          ${now}
        )
      `);
      for (const capability of capabilities) {
        await tx.run(sql`
          INSERT INTO connector_capabilities (connector_id, capability)
          VALUES (${id}, ${capability})
        `);
      }
    });
    const saved = await this.get(id, { orgId: input.orgId });
    if (!saved) throw new Error(`[PostgresConnectorRepository] create: row ${id} not found after insert`);
    return saved;
  }

  async update(id: string, patch: ConnectorPatch, orgId: string): Promise<Connector | null> {
    const existing = await this.get(id, { orgId });
    if (!existing) return null;
    const now = nowIso();
    const merged = {
      name: patch.name ?? existing.name,
      config: patch.config ?? existing.config,
      status: patch.status ?? existing.status,
      lastVerifiedAt: patch.lastVerifiedAt !== undefined ? patch.lastVerifiedAt : existing.lastVerifiedAt,
      lastVerifyError: patch.lastVerifyError !== undefined ? patch.lastVerifyError : existing.lastVerifyError,
      isDefault: patch.isDefault ?? existing.isDefault,
    };
    await this.db.withTransaction(async (tx) => {
      if (merged.isDefault) {
        await tx.run(sql`
          UPDATE connectors
          SET is_default = FALSE, updated_at = ${now}
          WHERE org_id = ${orgId}
            AND type = ${existing.type}
            AND id != ${id}
            AND is_default = TRUE
        `);
      }
      await tx.run(sql`
        UPDATE connectors SET
          name = ${merged.name},
          config = ${JSON.stringify(merged.config)}::jsonb,
          status = ${merged.status},
          last_verified_at = ${merged.lastVerifiedAt},
          last_verify_error = ${merged.lastVerifyError},
          is_default = ${merged.isDefault},
          updated_at = ${now}
        WHERE id = ${id} AND org_id = ${orgId}
      `);
    });
    return this.get(id, { orgId });
  }

  async delete(id: string, orgId: string): Promise<boolean> {
    const existing = await this.get(id, { orgId });
    if (!existing) return false;
    await pgRun(this.db, sql`DELETE FROM connectors WHERE id = ${id} AND org_id = ${orgId}`);
    return true;
  }

  async count(orgId: string): Promise<number> {
    const rows = await pgAll<{ n: string | number }>(
      this.db,
      sql`SELECT COUNT(*) AS n FROM connectors WHERE org_id = ${orgId}`,
    );
    return Number(rows[0]?.n ?? 0);
  }

  async findByCapability(orgId: string, capability: string): Promise<Connector[]> {
    return this.list({ orgId, capability });
  }

  async getSecret(connectorId: string): Promise<ConnectorSecret | null> {
    const rows = await pgAll<ConnectorSecretRow>(
      this.db,
      sql`SELECT * FROM connector_secrets WHERE connector_id = ${connectorId}`,
    );
    return rows[0] ? rowToSecret(rows[0]) : null;
  }

  async upsertSecret(input: UpsertConnectorSecret): Promise<ConnectorSecret> {
    const existing = await this.getSecret(input.connectorId);
    const now = nowIso();
    await pgRun(this.db, sql`
      INSERT INTO connector_secrets (connector_id, ciphertext, key_version, created_at, updated_at)
      VALUES (${input.connectorId}, ${input.ciphertext}, ${input.keyVersion}, ${now}, ${now})
      ON CONFLICT(connector_id) DO UPDATE SET
        ciphertext = excluded.ciphertext,
        key_version = excluded.key_version,
        updated_at = excluded.updated_at
    `);
    const saved = await this.getSecret(input.connectorId);
    if (!saved) throw new Error(`[PostgresConnectorRepository] upsertSecret: row ${input.connectorId} not found`);
    return existing ? { ...saved, createdAt: existing.createdAt } : saved;
  }

  async deleteSecret(connectorId: string): Promise<boolean> {
    const existing = await this.getSecret(connectorId);
    if (!existing) return false;
    await pgRun(this.db, sql`DELETE FROM connector_secrets WHERE connector_id = ${connectorId}`);
    return true;
  }

  async listPolicies(opts: ListConnectorPoliciesOptions): Promise<ConnectorTeamPolicy[]> {
    const wheres: SQL[] = [sql`connector_id = ${opts.connectorId}`];
    if (opts.teamId !== undefined) wheres.push(sql`team_id = ${opts.teamId}`);
    if (opts.capability) wheres.push(sql`capability = ${opts.capability}`);
    const rows = await pgAll<ConnectorPolicyRow>(this.db, sql`
      SELECT * FROM connector_team_policies
      WHERE ${sql.join(wheres, sql` AND `)}
      ORDER BY team_id, capability
    `);
    return rows.map(rowToPolicy);
  }

  async getPolicy(
    connectorId: string,
    teamId: string,
    capability: string,
  ): Promise<ConnectorTeamPolicy | null> {
    const rows = await pgAll<ConnectorPolicyRow>(this.db, sql`
      SELECT * FROM connector_team_policies
      WHERE connector_id = ${connectorId}
        AND team_id = ${teamId}
        AND capability = ${capability}
    `);
    return rows[0] ? rowToPolicy(rows[0]) : null;
  }

  async upsertPolicy(input: UpsertConnectorTeamPolicy): Promise<ConnectorTeamPolicy> {
    const teamId = input.teamId ?? '';
    await pgRun(this.db, sql`
      INSERT INTO connector_team_policies (
        connector_id, team_id, capability, scope, human_policy, agent_policy
      ) VALUES (
        ${input.connectorId},
        ${teamId},
        ${input.capability},
        ${stringifyJson(input.scope ?? null)}::jsonb,
        ${input.humanPolicy},
        ${input.agentPolicy}
      )
      ON CONFLICT(connector_id, team_id, capability) DO UPDATE SET
        scope = excluded.scope,
        human_policy = excluded.human_policy,
        agent_policy = excluded.agent_policy
    `);
    const saved = await this.getPolicy(input.connectorId, teamId, input.capability);
    if (!saved) throw new Error(`[PostgresConnectorRepository] upsertPolicy: row ${input.connectorId}/${teamId}/${input.capability} not found`);
    return saved;
  }

  async deletePolicy(connectorId: string, teamId: string, capability: string): Promise<boolean> {
    const existing = await this.getPolicy(connectorId, teamId, capability);
    if (!existing) return false;
    await pgRun(this.db, sql`
      DELETE FROM connector_team_policies
      WHERE connector_id = ${connectorId}
        AND team_id = ${teamId}
        AND capability = ${capability}
    `);
    return true;
  }
}
