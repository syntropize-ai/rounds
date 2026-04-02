import { eq } from 'drizzle-orm';
import { randomUUID } from 'crypto';
import { shareLinks } from '../../db/schema.js';
function rowToRecord(row) {
  return {
    id: row.id,
    investigationId: row.investigationId,
    token: row.token,
    createdBy: row.createdBy,
    permission: row.permission,
    expiresAt: row.expiresAt ? row.expiresAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
  };
}
export class PostgresShareRepository {
  db;
  constructor(db) {
    this.db = db;
  }
  async findById(id) {
    const [row] = await this.db.select().from(shareLinks).where(eq(shareLinks.id, id));
    if (!row)
      return undefined;
    const link = rowToRecord(row);
    return this.checkExpiry(link);
  }
  async findByToken(token) {
    const [row] = await this.db.select().from(shareLinks).where(eq(shareLinks.token, token));
    if (!row)
      return undefined;
    const link = rowToRecord(row);
    return this.checkExpiry(link);
  }
  async findAll(opts = {}) {
    const rows = await this.db
      .select()
      .from(shareLinks)
      .limit(opts?.limit ?? 100)
      .offset(opts?.offset ?? 0);
    return rows.map(rowToRecord);
  }
  async create(data) {
    const [row] = await this.db
      .insert(shareLinks)
      .values({
        id: data.id ?? randomUUID(),
        investigationId: data.investigationId,
        token: data.token,
        createdBy: data.createdBy,
        permission: data.permission,
        expiresAt: data.expiresAt ? new Date(data.expiresAt) : null,
        createdAt: new Date(),
      })
      .returning();
    return rowToRecord(row);
  }
  async update(id, patch) {
    const sets = {};
    if (patch.permission !== undefined)
      sets.permission = patch.permission;
    if (patch.expiresAt !== undefined)
      sets.expiresAt = patch.expiresAt ? new Date(patch.expiresAt) : null;
    const [row] = await this.db
      .update(shareLinks)
      .set(sets)
      .where(eq(shareLinks.id, id))
      .returning();
    return row ? rowToRecord(row) : undefined;
  }
  async delete(id) {
    const result = await this.db.delete(shareLinks).where(eq(shareLinks.id, id));
    return (result.rowCount ?? 0) > 0;
  }
  async count() {
    const rows = await this.db.select().from(shareLinks);
    return rows.length;
  }
  async findByInvestigation(investigationId) {
    const rows = await this.db
      .select()
      .from(shareLinks)
      .where(eq(shareLinks.investigationId, investigationId));
    const now = Date.now();
    return rows
      .map(rowToRecord)
      .filter((l) => !l.expiresAt || new Date(l.expiresAt).getTime() >= now);
  }
  async revoke(token) {
    const result = await this.db.delete(shareLinks).where(eq(shareLinks.token, token));
    return (result.rowCount ?? 0) > 0;
  }
  checkExpiry(link) {
    if (link.expiresAt && new Date(link.expiresAt).getTime() < Date.now()) {
      void this.db.delete(shareLinks).where(eq(shareLinks.token, link.token));
      return undefined;
    }
    return link;
  }
}
//# sourceMappingURL=share.js.map
