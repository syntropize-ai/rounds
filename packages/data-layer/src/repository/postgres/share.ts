import { eq } from 'drizzle-orm';
import { randomUUID } from 'crypto';
import { createLogger } from '@agentic-obs/common/logging';
import { shareLinks } from '../../db/schema.js';
import type { IShareLinkRepository, ShareLookupResult } from '../interfaces.js';
import type { ShareLink, SharePermission } from '../../stores/share-store.js';

type ShareRow = typeof shareLinks.$inferSelect;

const log = createLogger('share-repository');

function rowToShareLink(row: ShareRow): ShareLink {
  return {
    token: row.token,
    investigationId: row.investigationId,
    createdBy: row.createdBy,
    permission: row.permission as SharePermission,
    expiresAt: row.expiresAt ?? null,
    createdAt: row.createdAt,
  };
}

export class PostgresShareLinkRepository implements IShareLinkRepository {
  constructor(private readonly db: any) {}

  async create(params: {
    investigationId: string;
    createdBy: string;
    permission?: SharePermission;
    expiresInMs?: number;
  }): Promise<ShareLink> {
    const now = new Date();
    const token = randomUUID();
    const expiresAt = params.expiresInMs
      ? new Date(now.getTime() + params.expiresInMs).toISOString()
      : null;
    const [row] = await this.db
      .insert(shareLinks)
      .values({
        token,
        investigationId: params.investigationId,
        createdBy: params.createdBy,
        permission: params.permission ?? 'view_only',
        expiresAt,
        createdAt: now.toISOString(),
      })
      .returning();
    return rowToShareLink(row!);
  }

  /**
   * Distinguishes expired from not_found so the route layer can return 410
   * vs 404. Purges expired rows as a side effect and emits a structured warn.
   */
  async findByTokenStatus(token: string): Promise<ShareLookupResult> {
    const [row] = await this.db
      .select()
      .from(shareLinks)
      .where(eq(shareLinks.token, token));
    if (!row) return { kind: 'not_found' };
    const link = rowToShareLink(row);
    if (link.expiresAt && new Date(link.expiresAt).getTime() < Date.now()) {
      await this.db.delete(shareLinks).where(eq(shareLinks.token, link.token));
      log.warn(
        {
          token: link.token,
          investigationId: link.investigationId,
          expiresAt: link.expiresAt,
        },
        'share-repository: token expired — purging',
      );
      return { kind: 'expired' };
    }
    return { kind: 'ok', link };
  }

  async findByInvestigation(investigationId: string): Promise<ShareLink[]> {
    const rows = await this.db
      .select()
      .from(shareLinks)
      .where(eq(shareLinks.investigationId, investigationId));
    const now = Date.now();
    return rows
      .map(rowToShareLink)
      .filter((l: any) => !l.expiresAt || new Date(l.expiresAt).getTime() >= now);
  }

  async revoke(token: string): Promise<boolean> {
    const result = await this.db
      .delete(shareLinks)
      .where(eq(shareLinks.token, token))
      .returning();
    return result.length > 0;
  }
}
