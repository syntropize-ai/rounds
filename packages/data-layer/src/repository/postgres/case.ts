import { eq, and, like } from 'drizzle-orm';
import { randomUUID } from 'crypto';
import type { DbClient } from '../../db/client.js';
import { cases } from '../../db/schema.js';
import type { ICaseRepository, CaseFindAllOptions } from '../interfaces.js';
import type { Case } from '../types.js';

type CaseRow = typeof cases.$inferSelect;

function rowToCase(row: CaseRow): Case {
  return {
    id: row.id,
    tenantId: row.tenantId,
    title: row.title,
    symptoms: (row.symptoms as string[]) ?? [],
    rootCause: row.rootCause,
    resolution: row.resolution,
    services: (row.services as string[]) ?? [],
    tags: (row.tags as string[]) ?? [],
    evidenceRefs: (row.evidenceRefs as string[]) ?? [],
    actions: (row.actions as string[]) ?? [],
    outcome: row.outcome ?? undefined,
    createdAt: row.createdAt.toISOString(),
  };
}

export class PostgresCaseRepository implements ICaseRepository {
  constructor(private readonly db: DbClient) {}

  async findById(id: string): Promise<Case | undefined> {
    const [row] = await this.db.select().from(cases).where(eq(cases.id, id));
    return row ? rowToCase(row) : undefined;
  }

  async findAll(opts: CaseFindAllOptions = {}): Promise<Case[]> {
    const conditions = opts.tenantId ? [eq(cases.tenantId, opts.tenantId)] : [];
    const rows = await this.db
      .select()
      .from(cases)
      .where(conditions.length ? and(...conditions) : undefined)
      .limit(opts.limit ?? 100)
      .offset(opts.offset ?? 0);
    return rows.map(rowToCase);
  }

  async create(data: Omit<Case, 'id' | 'createdAt'> & { id?: string }): Promise<Case> {
    const [row] = await this.db
      .insert(cases)
      .values({
        id: data.id ?? `case_${randomUUID().slice(0, 8)}`,
        tenantId: data.tenantId,
        title: data.title,
        symptoms: data.symptoms,
        rootCause: data.rootCause,
        resolution: data.resolution,
        services: data.services,
        tags: data.tags,
        evidenceRefs: data.evidenceRefs,
        actions: data.actions,
        outcome: data.outcome,
        createdAt: new Date(),
      })
      .returning();
    return rowToCase(row);
  }

  async update(id: string, patch: Partial<Omit<Case, 'id'>>): Promise<Case | undefined> {
    const [row] = await this.db
      .update(cases)
      .set({
        ...(patch.title !== undefined ? { title: patch.title } : {}),
        ...(patch.rootCause !== undefined ? { rootCause: patch.rootCause } : {}),
        ...(patch.resolution !== undefined ? { resolution: patch.resolution } : {}),
        ...(patch.services !== undefined ? { services: patch.services } : {}),
        ...(patch.tags !== undefined ? { tags: patch.tags } : {}),
        ...(patch.outcome !== undefined ? { outcome: patch.outcome } : {}),
      })
      .where(eq(cases.id, id))
      .returning();
    return row ? rowToCase(row) : undefined;
  }

  async delete(id: string): Promise<boolean> {
    const result = await this.db.delete(cases).where(eq(cases.id, id));
    return (result.rowCount ?? 0) > 0;
  }

  async count(): Promise<number> {
    const rows = await this.db.select().from(cases);
    return rows.length;
  }

  async search(query: string, limit = 10, tenantId?: string): Promise<Case[]> {
    const conditions = [like(cases.title, `%${query}%`)];
    if (tenantId) conditions.push(eq(cases.tenantId, tenantId));
    const rows = await this.db
      .select()
      .from(cases)
      .where(and(...conditions))
      .limit(limit);
    return rows.map(rowToCase);
  }

  async findByService(serviceId: string, tenantId?: string): Promise<Case[]> {
    const rows = await this.db
      .select()
      .from(cases)
      .where(tenantId ? eq(cases.tenantId, tenantId) : undefined);
    return rows
      .filter((r) => (r.services as string[]).includes(serviceId))
      .map(rowToCase);
  }
}
