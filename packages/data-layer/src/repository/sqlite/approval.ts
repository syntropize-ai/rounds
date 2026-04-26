import { eq } from 'drizzle-orm';
import { randomUUID } from 'crypto';
import type { SqliteClient } from '../../db/sqlite-client.js';
import { toJsonColumn } from '../json-column.js';
import { approvals } from '../../db/sqlite-schema.js';
import type { IApprovalRequestRepository } from '../interfaces.js';
import type { ApprovalAction, ApprovalContext, ApprovalRequest } from '../../stores/approval-store.js';

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
  };
}

export class SqliteApprovalRequestRepository implements IApprovalRequestRepository {
  constructor(private readonly db: SqliteClient) {}

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
    return rows.map(rowToRequest).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
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
