import { eq, and, like } from 'drizzle-orm';
import { randomUUID } from 'crypto';
import { cases } from '../../db/schema.js';
function rowToCase(row) {
  return {
    id: row.id,
    tenantId: row.tenantId,
    title: row.title,
    symptoms: row.symptom ? [row.symptom] : [],
    rootCause: row.rootCause,
    resolution: row.resolution,
    services: row.services ?? [],
    tags: row.tags ?? [],
    evidenceRefs: row.evidenceRefs ?? [],
    actions: row.actions ?? [],
    outcomes: row.outcomes ?? undefined,
    createdAt: row.createdAt.toISOString(),
  };
}
export class PostgresCaseRepository {
  db;
  constructor(db) {
    this.db = db;
  }
  async findById(id) {
    const [row] = await this.db.select().from(cases).where(eq(cases.id, id));
    return row ? rowToCase(row) : undefined;
  }
  async findAll(opts = {}) {
    const conditions = opts.tenantId ? [eq(cases.tenantId, opts.tenantId)] : [];
    const rows = await this.db
      .select()
      .from(cases)
      .where(conditions.length ? and(...conditions) : undefined)
      .limit(opts.limit ?? 100)
      .offset(opts.offset ?? 0);
    return rows.map(rowToCase);
  }
  async create(data) {
    const [row] = await this.db
      .insert(cases)
      .values({
        id: data.id ?? `case_${randomUUID().slice(0, 8)}`,
        tenantId: data.tenantId,
        title: data.title,
        symptom: data.symptoms?.[0] ?? '',
        rootCause: data.rootCause,
        resolution: data.resolution,
        services: data.services,
        tags: data.tags,
        evidenceRefs: data.evidenceRefs,
        actions: data.actions,
        outcomes: data.outcomes,
        createdAt: new Date(),
      })
      .returning();
    return rowToCase(row);
  }
  async update(id, patch) {
    const [row] = await this.db
      .update(cases)
      .set({
        ...(patch.title !== undefined ? { title: patch.title } : {}),
        ...(patch.rootCause !== undefined ? { rootCause: patch.rootCause } : {}),
        ...(patch.resolution !== undefined ? { resolution: patch.resolution } : {}),
        ...(patch.services !== undefined ? { services: patch.services } : {}),
        ...(patch.tags !== undefined ? { tags: patch.tags } : {}),
        ...(patch.outcomes !== undefined ? { outcomes: patch.outcomes } : {}),
      })
      .where(eq(cases.id, id))
      .returning();
    return row ? rowToCase(row) : undefined;
  }
  async delete(id) {
    const result = await this.db.delete(cases).where(eq(cases.id, id));
    return (result.rowCount ?? 0) > 0;
  }
  async count() {
    const rows = await this.db.select().from(cases);
    return rows.length;
  }
  async search(query, limit = 10, tenantId) {
    const conditions = [like(cases.title, `%${query}%`)];
    if (tenantId)
      conditions.push(eq(cases.tenantId, tenantId));
    const rows = await this.db
      .select()
      .from(cases)
      .where(and(...conditions))
      .limit(limit);
    return rows.map(rowToCase);
  }
  async findByService(serviceId, tenantId) {
    const rows = await this.db
      .select()
      .from(cases)
      .where(tenantId ? eq(cases.tenantId, tenantId) : undefined);
    return rows
      .filter((r) => r.services.includes(serviceId))
      .map(rowToCase);
  }
}
//# sourceMappingURL=case.js.map
