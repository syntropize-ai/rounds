import { eq } from 'drizzle-orm';
import { randomUUID } from 'crypto';
import type { DbClient } from '../../db/client.js';
import { shareLinks } from '../../db/schema.js';
import type { IShareRepository, FindAllOptions } from '../interfaces.js';
import type { ShareLink } from '../types.js';

type ShareRow = typeof shareLinks.$inferSelect;

function rowToRecord(row: ShareRow): ShareLink {
  return {
    id: row.id,
    investigationId: row.investigationId,
    token: row.token,
    createdBy: row.createdBy,
    permission: row.permission as ShareLink['permission'],
    expiresAt: row.expiresAt ? row.expiresAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
  };
}

export class PostgresShareRepository implements IShareRepository {
  constructor(private readonly db: DbClient) {}

  async findById(id: string): Promise<ShareLink | undefined> {
    const [row] = await this.db.select().from(shareLinks).where(eq(shareLinks.id, id));
    if (!row) return undefined;
    const link = rowToRecord(row);
    return this.checkExpiry(link);
  }

  async findByToken(token: string): Promise<ShareLink | undefined> {
    const [row] = await this.db.select().from(shareLinks).where(eq(shareLinks.token, token));
    if (!row) return undefined;
    const link = rowToRecord(row);
    return this.checkExpiry(link);
  }

  async findAll(opts?: FindAllOptions<ShareLink>): Promise<ShareLink[]> {
    const rows = await this.db
      .select()
      .from(shareLinks)
      .limit(opts?.limit ?? 100)
      .offset(opts?.offset ?? 0);
    return rows.map(rowToRecord);
  }

  async create(data: Omit<ShareLink, 'id' | 'createdAt'> & { id?: string }): Promise<ShareLink> {
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
    return rowToRecord(row!);
  }

  async update(id: string, patch: Partial<Omit<ShareLink, 'id'>>): Promise<ShareLink | undefined> {
    const sets: Record<string, unknown> = {};
    if (patch.permission !== undefined) sets['permission'] = patch.permission;
    if (patch.expiresAt !== undefined) sets['expiresAt'] = patch.expiresAt ? new Date(patch.expiresAt) : null;
    const [row] = await this.db
      .update(shareLinks)
      .set(sets)
      .where(eq(shareLinks.id, id))
      .returning();
    return row ? rowToRecord(row) : undefined;
  }

  async delete(id: string): Promise<boolean> {
    const result = await this.db.delete(shareLinks).where(eq(shareLinks.id, id));
    return (result.rowCount ?? 0) > 0;
  }

  async count(): Promise<number> {
    const rows = await this.db.select().from(shareLinks);
    return rows.length;
  }

  async findByInvestigation(investigationId: string): Promise<ShareLink[]> {
    const rows = await this.db
      .select()
      .from(shareLinks)
      .where(eq(shareLinks.investigationId, investigationId));
    const now = Date.now();
    return rows
      .map(rowToRecord)
      .filter((l) => !l.expiresAt || new Date(l.expiresAt).getTime() >= now);
  }

  async revoke(token: string): Promise<boolean> {
    const result = await this.db.delete(shareLinks).where(eq(shareLinks.token, token));
    return (result.rowCount ?? 0) > 0;
  }

  private checkExpiry(link: ShareLink): ShareLink | undefined {
    if (link.expiresAt && new Date(link.expiresAt).getTime() < Date.now()) {
      void this.db.delete(shareLinks).where(eq(shareLinks.token, link.token));
      return undefined;
    }
    return link;
  }
}
