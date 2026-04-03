import { eq, and } from 'drizzle-orm';
import { randomUUID } from 'crypto';
import type { DbClient } from '../../db/client.js';
import { approvals } from '../../db/schema.js';
import type { IApprovalRepository, FindAllOptions } from '../interfaces.js';
import type { ApprovalRecord } from '../types.js';

type ApprovalRow = typeof approvals.$inferSelect;

function rowToRecord(row: ApprovalRow): ApprovalRecord {
  const params = (row.params ?? {}) as Record<string, unknown>;
  return {
    id: row.id,
    tenantId: row.tenantId,
    actionType: row.actionType,
    action: {
      type: String(params['type'] ?? row.actionType),
      targetService: String(params['targetService'] ?? ''),
      params,
    },
    context: {
      investigationId:
        typeof params['investigationId'] === 'string' ? params['investigationId'] : undefined,
      requestedBy: row.requestedBy,
      reason: typeof params['reason'] === 'string' ? params['reason'] : '',
    },
    requestedBy: row.requestedBy,
    resolvedBy: row.resolvedBy ?? undefined,
    status: row.status as ApprovalRecord['status'],
    params,
    expiresAt: new Date(Date.now() + 86400000).toISOString(),
    createdAt: row.createdAt.toISOString(),
    resolvedAt: row.resolvedAt?.toISOString(),
  };
}

export class PostgresApprovalRepository implements IApprovalRepository {
  constructor(private readonly db: DbClient) {}

  async findById(id: string): Promise<ApprovalRecord | undefined> {
    const [row] = await this.db.select().from(approvals).where(eq(approvals.id, id));
    return row ? rowToRecord(row) : undefined;
  }

  async findAll(opts?: FindAllOptions<ApprovalRecord>): Promise<ApprovalRecord[]> {
    const rows = await this.db
      .select()
      .from(approvals)
      .limit(opts?.limit ?? 100)
      .offset(opts?.offset ?? 0);
    return rows.map(rowToRecord);
  }

  async create(
    data: Omit<ApprovalRecord, 'id' | 'createdAt'> & { id?: string },
  ): Promise<ApprovalRecord> {
    return this.submit(data);
  }

  async submit(data: Omit<ApprovalRecord, 'id' | 'createdAt'>): Promise<ApprovalRecord> {
    const [row] = await this.db
      .insert(approvals)
      .values({
        id: randomUUID(),
        tenantId: data.tenantId,
        actionType: data.actionType,
        requestedBy: data.requestedBy,
        status: data.status,
        params: data.params,
        createdAt: new Date(),
      })
      .returning();
    return rowToRecord(row!);
  }

  async update(
    id: string,
    patch: Partial<Omit<ApprovalRecord, 'id'>>,
  ): Promise<ApprovalRecord | undefined> {
    const [row] = await this.db
      .update(approvals)
      .set({
        ...(patch.status !== undefined ? { status: patch.status } : {}),
        ...(patch.resolvedBy !== undefined ? { resolvedBy: patch.resolvedBy } : {}),
        ...(patch.resolvedAt !== undefined ? { resolvedAt: new Date(patch.resolvedAt) } : {}),
      })
      .where(eq(approvals.id, id))
      .returning();
    return row ? rowToRecord(row) : undefined;
  }

  async delete(id: string): Promise<boolean> {
    const result = await this.db.delete(approvals).where(eq(approvals.id, id));
    return (result.rowCount ?? 0) > 0;
  }

  async count(): Promise<number> {
    const rows = await this.db.select().from(approvals);
    return rows.length;
  }

  async listPending(tenantId?: string): Promise<ApprovalRecord[]> {
    const conditions = [eq(approvals.status, 'pending')];
    if (tenantId) conditions.push(eq(approvals.tenantId, tenantId));
    const rows = await this.db.select().from(approvals).where(and(...conditions));
    return rows.map(rowToRecord).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  async approve(id: string, by: string, roles?: string[]): Promise<ApprovalRecord | undefined> {
    const existing = await this.findById(id);
    if (!existing || existing.status !== 'pending') return undefined;
    return this.update(id, { status: 'approved', resolvedBy: by, resolvedAt: new Date().toISOString() });
  }

  async reject(id: string, by: string, roles?: string[]): Promise<ApprovalRecord | undefined> {
    const existing = await this.findById(id);
    if (!existing || existing.status !== 'pending') return undefined;
    return this.update(id, { status: 'rejected', resolvedBy: by, resolvedAt: new Date().toISOString() });
  }

  async override(id: string, by: string, roles?: string[]): Promise<ApprovalRecord | undefined> {
    return this.update(id, { status: 'approved', resolvedBy: by, resolvedAt: new Date().toISOString() });
  }
}
