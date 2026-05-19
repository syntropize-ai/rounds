/**
 * Postgres-backed `pending_changes` repository. Mirrors
 * `../sqlite/pending-change.ts`. Corrupt JSON throws — no silent fallback.
 */

import { sql } from 'drizzle-orm';
import { createLogger } from '@agentic-obs/server-utils/logging';
import type { DbClient } from '../../db/client.js';
import type {
  IPendingChangeRepository,
  PendingChange,
  PendingChangeStatus,
} from '../interfaces.js';

const log = createLogger('postgres-pending-change-repository');

interface PendingChangeRow {
  id: string;
  org_id: string;
  dashboard_id: string;
  panel_id: string | null;
  proposed_by: string;
  proposed_at: string;
  status: string;
  resolved_at: string | null;
  resolved_by: string | null;
  change_kind: string;
  before_json: string | null;
  after_json: string;
  summary: string;
  expires_at: string;
}

function parseJsonColumn(raw: unknown, rowId: string, column: string): unknown {
  if (typeof raw !== 'string') return raw;
  try {
    return JSON.parse(raw);
  } catch (err) {
    log.error(
      { rowId, column, err: err instanceof Error ? err.message : String(err) },
      'corrupt JSON in pending_changes row — refusing to return fallback',
    );
    throw new Error(
      `[PendingChangeRepository] corrupt JSON in column "${column}" for row ${rowId}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}

function rowTo(r: PendingChangeRow): PendingChange {
  return {
    id: r.id,
    orgId: r.org_id,
    dashboardId: r.dashboard_id,
    panelId: r.panel_id,
    proposedBy: r.proposed_by,
    proposedAt: r.proposed_at,
    status: r.status as PendingChangeStatus,
    resolvedAt: r.resolved_at,
    resolvedBy: r.resolved_by,
    changeKind: r.change_kind as PendingChange['changeKind'],
    beforeJson: r.before_json == null ? null : parseJsonColumn(r.before_json, r.id, 'before_json'),
    afterJson: parseJsonColumn(r.after_json, r.id, 'after_json'),
    summary: r.summary,
    expiresAt: r.expires_at,
  };
}

export class PostgresPendingChangeRepository implements IPendingChangeRepository {
  constructor(private readonly db: DbClient) {}

  async insert(
    input: Omit<PendingChange, 'resolvedAt' | 'resolvedBy' | 'status'> & {
      status?: PendingChangeStatus;
    },
  ): Promise<PendingChange> {
    const status = input.status ?? 'pending';
    await this.db.run(sql`
      INSERT INTO pending_changes (
        id, org_id, dashboard_id, panel_id, proposed_by, proposed_at,
        status, resolved_at, resolved_by,
        change_kind, before_json, after_json, summary, expires_at
      ) VALUES (
        ${input.id},
        ${input.orgId},
        ${input.dashboardId},
        ${input.panelId},
        ${input.proposedBy},
        ${input.proposedAt},
        ${status},
        ${null},
        ${null},
        ${input.changeKind},
        ${input.beforeJson == null ? null : JSON.stringify(input.beforeJson)},
        ${JSON.stringify(input.afterJson)},
        ${input.summary},
        ${input.expiresAt}
      )
    `);
    const saved = await this.getById(input.orgId, input.id);
    if (!saved) {
      throw new Error(
        `[PendingChangeRepository] insert: row ${input.id} not found after insert`,
      );
    }
    return saved;
  }

  async getById(orgId: string, id: string): Promise<PendingChange | null> {
    const rows = await this.db.all<PendingChangeRow>(
      sql`SELECT * FROM pending_changes WHERE org_id = ${orgId} AND id = ${id} LIMIT 1`,
    );
    if (rows.length === 0) return null;
    return rowTo(rows[0]!);
  }

  async listByDashboard(
    orgId: string,
    dashboardId: string,
    opts?: { status?: PendingChangeStatus },
  ): Promise<PendingChange[]> {
    const status = opts?.status ?? 'pending';
    const rows = await this.db.all<PendingChangeRow>(sql`
      SELECT * FROM pending_changes
      WHERE org_id = ${orgId} AND dashboard_id = ${dashboardId} AND status = ${status}
      ORDER BY proposed_at DESC
    `);
    return rows.map(rowTo);
  }

  async countByOrg(orgId: string, status?: PendingChangeStatus): Promise<number> {
    const s = status ?? 'pending';
    const rows = await this.db.all<{ c: number | string }>(sql`
      SELECT COUNT(*)::int AS c FROM pending_changes
      WHERE org_id = ${orgId} AND status = ${s}
    `);
    return Number(rows[0]?.c ?? 0);
  }

  async countByOrgGrouped(
    orgId: string,
    status?: PendingChangeStatus,
  ): Promise<Array<{ dashboardId: string; count: number }>> {
    const s = status ?? 'pending';
    const rows = await this.db.all<{ dashboard_id: string; c: number | string }>(sql`
      SELECT dashboard_id, COUNT(*)::int AS c FROM pending_changes
      WHERE org_id = ${orgId} AND status = ${s}
      GROUP BY dashboard_id
      ORDER BY c DESC
    `);
    return rows.map((r) => ({ dashboardId: r.dashboard_id, count: Number(r.c) }));
  }

  async resolve(
    orgId: string,
    id: string,
    status: 'accepted' | 'rejected',
    resolvedBy: string,
  ): Promise<PendingChange | null> {
    const now = new Date().toISOString();
    await this.db.run(sql`
      UPDATE pending_changes
      SET status = ${status}, resolved_at = ${now}, resolved_by = ${resolvedBy}
      WHERE org_id = ${orgId} AND id = ${id} AND status = 'pending'
    `);
    return this.getById(orgId, id);
  }

  async expireOlderThan(now: string): Promise<number> {
    const before = await this.db.all<{ c: number | string }>(sql`
      SELECT COUNT(*)::int AS c FROM pending_changes
      WHERE status = 'pending' AND expires_at <= ${now}
    `);
    const count = Number(before[0]?.c ?? 0);
    if (count === 0) return 0;
    await this.db.run(sql`
      UPDATE pending_changes
      SET status = 'expired', resolved_at = ${now}
      WHERE status = 'pending' AND expires_at <= ${now}
    `);
    return count;
  }
}
