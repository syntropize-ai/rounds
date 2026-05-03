import { and, eq, inArray, or, sql, type SQL } from 'drizzle-orm';
import { randomUUID } from 'crypto';
import { toJsonColumn } from '../json-column.js';
import { approvals } from '../../db/schema.js';
import type { ApprovalScopeFilter, IApprovalRequestRepository } from '../interfaces.js';
import type { ApprovalAction, ApprovalContext, ApprovalRequest, ApprovalStatus } from '../../stores/approval-store.js';

type ApprovalRow = typeof approvals.$inferSelect;

function rowToRequest(row: ApprovalRow): ApprovalRequest {
  return {
    id: row.id,
    action: row.action as ApprovalAction,
    context: row.context as ApprovalContext,
    status: row.status as ApprovalRequest['status'],
    expiresAt: row.expiresAt,
    createdAt: row.createdAt,
    resolvedAt: row.resolvedAt ?? undefined,
    resolvedBy: row.resolvedBy ?? undefined,
    resolvedByRoles: (row.resolvedByRoles as string[]) ?? undefined,
    opsConnectorId: row.opsConnectorId,
    targetNamespace: row.targetNamespace,
    requesterTeamId: row.requesterTeamId,
  };
}

export class PostgresApprovalRequestRepository implements IApprovalRequestRepository {
  constructor(private readonly db: any) {}

  async findById(id: string): Promise<ApprovalRequest | undefined> {
    const [row] = await this.db.select().from(approvals).where(eq(approvals.id, id));
    return row ? rowToRequest(row) : undefined;
  }

  async submit(params: {
    action: ApprovalAction;
    context: ApprovalContext;
    ttlMs?: number;
  }): Promise<ApprovalRequest> {
    const now = new Date();
    const expiresAt = new Date(now.getTime() + (params.ttlMs ?? 86400000)).toISOString();
    const [row] = await this.db
      .insert(approvals)
      .values({
        id: randomUUID(),
        action: toJsonColumn(params.action),
        context: toJsonColumn(params.context),
        status: 'pending',
        expiresAt,
        createdAt: now.toISOString(),
      })
      .returning();
    return rowToRequest(row!);
  }

  async listPending(): Promise<ApprovalRequest[]> {
    const rows = await this.db
      .select()
      .from(approvals)
      .where(eq(approvals.status, 'pending'));
    return rows.map(rowToRequest).sort((a: any, b: any) => a.createdAt.localeCompare(b.createdAt));
  }

  async list(
    orgId: string,
    opts?: { scopeFilter?: ApprovalScopeFilter; status?: ApprovalStatus | ApprovalStatus[] },
  ): Promise<ApprovalRequest[]> {
    const where = buildListWhere(orgId, opts);
    if (where === 'EMPTY') return [];
    const rows = await this.db.select().from(approvals).where(where);
    return rows
      .map(rowToRequest)
      .sort((a: ApprovalRequest, b: ApprovalRequest) => a.createdAt.localeCompare(b.createdAt));
  }

  async approve(id: string, by: string, roles?: string[]): Promise<ApprovalRequest | undefined> {
    const existing = await this.findById(id);
    if (!existing || existing.status !== 'pending') return undefined;
    return this.resolve(id, 'approved', by, roles);
  }

  async reject(id: string, by: string, roles?: string[]): Promise<ApprovalRequest | undefined> {
    const existing = await this.findById(id);
    if (!existing || existing.status !== 'pending') return undefined;
    return this.resolve(id, 'rejected', by, roles);
  }

  async override(id: string, by: string, roles?: string[]): Promise<ApprovalRequest | undefined> {
    return this.resolve(id, 'approved', by, roles);
  }

  private async resolve(
    id: string,
    status: string,
    by: string,
    roles?: string[],
  ): Promise<ApprovalRequest | undefined> {
    const now = new Date().toISOString();
    const sets: Record<string, unknown> = {
      status,
      resolvedBy: by,
      resolvedAt: now,
    };
    if (roles) sets.resolvedByRoles = roles;
    const [row] = await this.db
      .update(approvals)
      .set(sets)
      .where(eq(approvals.id, id))
      .returning();
    return row ? rowToRequest(row) : undefined;
  }
}

/**
 * Build the WHERE for `list()`. Returns a drizzle SQL clause, or the sentinel
 * `'EMPTY'` when the scope filter is `narrow` with all sets empty (caller
 * should short-circuit to zero rows — never fall back to org-wide).
 *
 * NULL semantics: connector-only / namespace-pair / team grants do NOT match
 * rows where the corresponding column is NULL (standard SQL `IN` with NULL
 * is unknown → row not selected; same in postgres and sqlite).
 */
function buildListWhere(
  orgId: string,
  opts?: { scopeFilter?: ApprovalScopeFilter; status?: ApprovalStatus | ApprovalStatus[] },
): SQL | 'EMPTY' {
  const conds: SQL[] = [eq(approvals.orgId, orgId)];

  const status = opts?.status;
  if (status !== undefined) {
    if (Array.isArray(status)) {
      if (status.length === 0) return 'EMPTY';
      conds.push(inArray(approvals.status, status));
    } else {
      conds.push(eq(approvals.status, status));
    }
  }

  const filter = opts?.scopeFilter;
  if (filter && filter.kind === 'narrow') {
    const ors: SQL[] = [];
    if (filter.uids && filter.uids.size > 0) {
      ors.push(inArray(approvals.id, [...filter.uids]));
    }
    if (filter.connectors && filter.connectors.size > 0) {
      ors.push(inArray(approvals.opsConnectorId, [...filter.connectors]));
    }
    if (filter.nsPairs && filter.nsPairs.length > 0) {
      const pairOrs = filter.nsPairs.map(
        (p) =>
          sql`(${approvals.opsConnectorId} = ${p.connectorId} AND ${approvals.targetNamespace} = ${p.ns})`,
      );
      const joined = pairOrs.reduce<SQL | undefined>(
        (acc, x) => (acc ? sql`${acc} OR ${x}` : x),
        undefined,
      );
      if (joined) ors.push(sql`(${joined})`);
    }
    if (filter.teams && filter.teams.size > 0) {
      ors.push(inArray(approvals.requesterTeamId, [...filter.teams]));
    }
    if (ors.length === 0) return 'EMPTY';
    conds.push(or(...ors)!);
  }

  return and(...conds)!;
}
