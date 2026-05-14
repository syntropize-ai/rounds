/**
 * In-memory share-link fixture. Per ADR-001, repositories are canonical; this
 * file remains as a test fixture implementing `IShareLinkRepository` so unit
 * tests can avoid spinning up SQLite. Production boot wires the SQLite or
 * Postgres repository, never this class.
 */
import { randomUUID } from 'node:crypto';
import { createLogger } from '@agentic-obs/common/logging';
import type { Persistable } from './persistence.js';
import { markDirty } from './persistence.js';
import type { IShareLinkRepository, ShareLookupResult } from '../repository/interfaces.js';

export type SharePermission = 'view_only' | 'can_comment';

export interface ShareLink {
  token: string;
  investigationId: string;
  createdBy: string;
  permission: SharePermission;
  createdAt: string;
  expiresAt: string | null;
}

// Re-export for back-compat with the existing public type alias.
export type { ShareLookupResult };

const log = createLogger('share-store');

export class InMemoryShareLinkRepository implements IShareLinkRepository, Persistable {
  private readonly shares = new Map<string, ShareLink>();

  create(params: {
    investigationId: string;
    createdBy: string;
    permission?: SharePermission;
    expiresInMs?: number;
  }): ShareLink {
    const token = randomUUID();
    const now = new Date();
    const link: ShareLink = {
      token,
      investigationId: params.investigationId,
      createdBy: params.createdBy,
      permission: params.permission ?? 'view_only',
      createdAt: now.toISOString(),
      expiresAt: params.expiresInMs
        ? new Date(now.getTime() + params.expiresInMs).toISOString()
        : null,
    };
    this.shares.set(token, link);
    markDirty();
    return link;
  }

  /**
   * Distinguishes `expired` from `not_found` so the route layer can return a
   * specific 410 / "this link expired" response instead of a generic 404.
   * Emits a structured warn on expiry detection so operators can correlate
   * failed share visits to expired links.
   */
  findByTokenStatus(token: string): ShareLookupResult {
    const link = this.shares.get(token);
    if (!link)
      return { kind: 'not_found' };

    if (link.expiresAt && new Date(link.expiresAt).getTime() < Date.now()) {
      this.shares.delete(token);
      markDirty();
      log.warn(
        {
          token,
          investigationId: link.investigationId,
          expiresAt: link.expiresAt,
        },
        'share-store: token expired — purging',
      );
      return { kind: 'expired' };
    }

    return { kind: 'ok', link };
  }

  findByInvestigation(investigationId: string): ShareLink[] {
    const now = Date.now();
    return [...this.shares.values()].filter(
      (s) => s.investigationId === investigationId
        && (!s.expiresAt || new Date(s.expiresAt).getTime() >= now),
    );
  }

  revoke(token: string): boolean {
    const result = this.shares.delete(token);
    if (result)
      markDirty();
    return result;
  }

  get size(): number {
    return this.shares.size;
  }

  clear(): void {
    this.shares.clear();
  }

  toJSON(): unknown {
    return [...this.shares.values()];
  }

  loadJSON(data: unknown): void {
    if (!Array.isArray(data))
      return;
    for (const s of data as ShareLink[]) {
      if (s?.token)
        this.shares.set(s.token, s);
    }
  }
}
