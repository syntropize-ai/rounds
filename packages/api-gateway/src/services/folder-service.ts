/**
 * FolderService — CRUD + hierarchy operations on the Grafana-parity folder
 * table.
 *
 * Implements the contract from docs/auth-perm-design/07-resource-permissions.md
 * §folders. Wraps `FolderRepository`, adds:
 *   - uid slugification when the caller doesn't supply one,
 *   - max-depth + cycle enforcement (repo enforces too — we duplicate so the
 *     service can emit a friendly 400 instead of a 500),
 *   - "folder contains alert rules" check on delete,
 *   - cascade on delete: sub-folders + dashboards + alert rules in the tree.
 *
 * Grafana reference (read for semantics only):
 *   pkg/services/folder/folderimpl/folder.go      — create/update/delete flow
 *   pkg/services/folder/folderimpl/service.go     — hierarchy ops
 *   pkg/api/folder.go                              — HTTP handlers
 */

import { sql } from 'drizzle-orm';
import type {
  IFolderRepository,
  GrafanaFolder,
  NewGrafanaFolder,
  GrafanaFolderPatch,
  ResourceSource,
  ResourceProvenance,
  FolderKind,
} from '@agentic-obs/common';
import { AuditAction, FOLDER_MAX_DEPTH, personalFolderUid } from '@agentic-obs/common';
import type { QueryClient } from '@agentic-obs/data-layer';
import type { AuditWriter } from '../auth/audit-writer.js';

export class FolderServiceError extends Error {
  constructor(
    public readonly kind:
      | 'validation'
      | 'conflict'
      | 'not_found'
      | 'has_dependents',
    message: string,
    public readonly statusCode: number,
  ) {
    super(message);
    this.name = 'FolderServiceError';
  }
}

export interface CreateFolderInput {
  uid?: string;
  title: string;
  description?: string;
  parentUid?: string | null;
  /** Defaults to `'manual'` when unset. */
  source?: ResourceSource;
  provenance?: ResourceProvenance;
  /**
   * Internal only — `'personal'` is rejected by the public CRUD path. The
   * personal-workspace lazy-create flow calls `getOrCreatePersonal()` directly,
   * which bypasses `create()` entirely.
   */
  kind?: FolderKind;
}

export interface UpdateFolderPatch {
  title?: string;
  description?: string | null;
  parentUid?: string | null;
}

export interface FolderCounts {
  dashboards: number;
  subfolders: number;
  alertRules: number;
}

export interface ListFoldersOpts {
  parentUid?: string | null;
  query?: string;
  limit?: number;
  offset?: number;
}

export interface FolderServiceDeps {
  folders: IFolderRepository;
  /**
   * Raw repository database client — used for the cross-table reads (dashboards count,
   * alert-rule count) that aren't worth a dedicated repository method, and for
   * the cascade delete that walks multiple tables in one transaction.
   */
  db: QueryClient;
  /**
   * Audit writer — records folder.create/update/delete events. Optional so
   * tests can construct the service without one.
   */
  audit?: AuditWriter;
}

/** Slugify a title into a URL-safe UID. Mirrors Grafana's folder UID rule. */
export function slugifyUid(title: string): string {
  // Grafana truncates at 40 chars, lowercases, and replaces non-alnum runs
  // with `_`. We match, then trim leading/trailing underscores.
  const base = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40);
  if (base.length === 0) return `folder_${Math.random().toString(36).slice(2, 10)}`;
  return base;
}

export class FolderService {
  constructor(private readonly deps: FolderServiceDeps) {}

  async create(
    orgId: string,
    input: CreateFolderInput,
    userId: string,
  ): Promise<GrafanaFolder> {
    if (!input.title?.trim()) {
      throw new FolderServiceError('validation', 'title is required', 400);
    }
    // Wave 1 / PR-C: personal folders are owned by exactly one user and are
    // created only by the workspace lazy-init flow (`getOrCreatePersonal`).
    // Any public-API attempt to mint one is rejected.
    if (input.kind === 'personal') {
      throw new FolderServiceError(
        'validation',
        "folder kind 'personal' is reserved for the user's workspace; use GET /api/workspace/me",
        400,
      );
    }
    let uid = input.uid?.trim() || slugifyUid(input.title);
    // If the slugified uid already exists, append a short suffix to disambiguate.
    if (await this.deps.folders.findByUid(orgId, uid)) {
      if (input.uid) {
        // Explicit uid collision — caller's responsibility, 409.
        throw new FolderServiceError(
          'conflict',
          `folder uid already exists: ${uid}`,
          409,
        );
      }
      uid = `${uid}_${Math.random().toString(36).slice(2, 8)}`;
    }

    // Parent / depth / cycle checks (repo also enforces; we re-throw as 400).
    if (input.parentUid) {
      const parent = await this.deps.folders.findByUid(orgId, input.parentUid);
      if (!parent) {
        throw new FolderServiceError(
          'validation',
          `parent folder not found: ${input.parentUid}`,
          400,
        );
      }
      // Depth = 1 (parent) + ancestor count + 1 (self).
      const ancestors = await this.deps.folders.listAncestors(
        orgId,
        input.parentUid,
      );
      if (ancestors.length + 2 > FOLDER_MAX_DEPTH) {
        throw new FolderServiceError(
          'validation',
          `folder depth would exceed limit of ${FOLDER_MAX_DEPTH}`,
          400,
        );
      }
    }

    const now = new Date();
    void now; // kept for clarity — repo stamps timestamps
    const payload: NewGrafanaFolder = {
      uid,
      orgId,
      title: input.title.trim(),
      description: input.description ?? null,
      parentUid: input.parentUid ?? null,
      kind: 'shared',
      createdBy: userId,
      updatedBy: userId,
      source: input.source ?? 'manual',
      ...(input.provenance ? { provenance: input.provenance } : {}),
    };
    try {
      const folder = await this.deps.folders.create(payload);
      void this.deps.audit?.log({
        action: AuditAction.FolderCreate,
        actorType: 'user',
        actorId: userId,
        orgId,
        targetType: 'folder',
        targetId: folder.uid,
        targetName: folder.title,
        outcome: 'success',
        metadata: { parentUid: folder.parentUid },
      });
      return folder;
    } catch (err) {
      // Repo throws plain Error; map to 400 for operator-friendly feedback.
      throw new FolderServiceError(
        'validation',
        err instanceof Error ? err.message : 'create failed',
        400,
      );
    }
  }

  async getByUid(orgId: string, uid: string): Promise<GrafanaFolder | null> {
    return this.deps.folders.findByUid(orgId, uid);
  }

  async list(
    orgId: string,
    opts: ListFoldersOpts = {},
    currentUserId?: string,
  ): Promise<(GrafanaFolder & { counts: FolderCounts })[]> {
    const { items } = await this.deps.folders.list({
      orgId,
      // `undefined` = "all folders". `null` = "roots only". A concrete string =
      // "direct children of this folder".
      parentUid: opts.parentUid,
      limit: opts.limit ?? 200,
      offset: opts.offset ?? 0,
    });
    // Wave 1 / PR-C RBAC: personal folders are visible to their owner only.
    // The owner is identified by `uid === 'user:<userId>'`. When no
    // currentUserId is supplied (server-internal callers), personal folders
    // are filtered out entirely — only `getOrCreatePersonal` bypasses this.
    const expectedUid = currentUserId ? personalFolderUid(currentUserId) : null;
    const visible = items.filter(
      (f) => f.kind !== 'personal' || f.uid === expectedUid,
    );
    const filtered = opts.query
      ? visible.filter((f) => f.title.toLowerCase().includes(opts.query!.toLowerCase()))
      : visible;
    const countsByUid = await this.getFolderCounts(
      orgId,
      filtered.map((f) => f.uid),
    );
    return filtered.map((f) => ({
      ...f,
      counts: countsByUid.get(f.uid) ?? { dashboards: 0, alertRules: 0, subfolders: 0 },
    }));
  }

  /**
   * Batch counts for many folders. Three GROUP BY queries — one per resource
   * type — joined in memory. Returns a map keyed by folder uid; folders with
   * zero of every resource may be missing from the map (callers should default
   * to zeros).
   */
  async getFolderCounts(
    orgId: string,
    folderUids: string[],
  ): Promise<Map<string, FolderCounts>> {
    const out = new Map<string, FolderCounts>();
    if (folderUids.length === 0) return out;
    const placeholders = sql.join(
      folderUids.map((u) => sql`${u}`),
      sql`, `,
    );
    const ensure = (uid: string): FolderCounts => {
      let c = out.get(uid);
      if (!c) {
        c = { dashboards: 0, alertRules: 0, subfolders: 0 };
        out.set(uid, c);
      }
      return c;
    };
    const dashRows = await this.deps.db.all<{ folder_uid: string; n: number }>(sql`
      SELECT folder_uid, COUNT(*) AS n FROM dashboards
      WHERE org_id = ${orgId} AND folder_uid IN (${placeholders})
      GROUP BY folder_uid
    `);
    for (const r of dashRows) ensure(r.folder_uid).dashboards = Number(r.n);
    const ruleRows = await this.deps.db.all<{ folder_uid: string; n: number }>(sql`
      SELECT folder_uid, COUNT(*) AS n FROM alert_rules
      WHERE org_id = ${orgId} AND folder_uid IN (${placeholders})
      GROUP BY folder_uid
    `);
    for (const r of ruleRows) ensure(r.folder_uid).alertRules = Number(r.n);
    const subRows = await this.deps.db.all<{ parent_uid: string; n: number }>(sql`
      SELECT parent_uid, COUNT(*) AS n FROM folder
      WHERE org_id = ${orgId} AND parent_uid IN (${placeholders})
      GROUP BY parent_uid
    `);
    for (const r of subRows) ensure(r.parent_uid).subfolders = Number(r.n);
    return out;
  }

  async update(
    orgId: string,
    uid: string,
    patch: UpdateFolderPatch,
    userId: string,
  ): Promise<GrafanaFolder> {
    const existing = await this.deps.folders.findByUid(orgId, uid);
    if (!existing) {
      throw new FolderServiceError('not_found', `folder not found: ${uid}`, 404);
    }

    // Cycle prevention when moving: new parent must not be a descendant.
    if (
      patch.parentUid !== undefined &&
      patch.parentUid !== existing.parentUid
    ) {
      if (patch.parentUid === uid) {
        throw new FolderServiceError(
          'validation',
          'folder cannot be its own parent',
          400,
        );
      }
      if (patch.parentUid) {
        const descendants = await this.listDescendantUids(orgId, uid);
        if (descendants.has(patch.parentUid)) {
          throw new FolderServiceError(
            'validation',
            'cannot move folder under its own descendant',
            400,
          );
        }
        const ancestors = await this.deps.folders.listAncestors(
          orgId,
          patch.parentUid,
        );
        // depth = ancestors of new parent + parent itself + this folder's own subtree depth
        const subtreeDepth = await this.measureSubtreeDepth(orgId, uid);
        if (ancestors.length + 2 + subtreeDepth - 1 > FOLDER_MAX_DEPTH) {
          throw new FolderServiceError(
            'validation',
            `folder depth would exceed limit of ${FOLDER_MAX_DEPTH}`,
            400,
          );
        }
      }
    }

    const repoPatch: GrafanaFolderPatch = {
      title: patch.title,
      description: patch.description,
      parentUid: patch.parentUid,
      updatedBy: userId,
    };
    try {
      const updated = await this.deps.folders.update(existing.id, repoPatch);
      if (!updated) {
        throw new FolderServiceError('not_found', `folder not found: ${uid}`, 404);
      }
      void this.deps.audit?.log({
        action: AuditAction.FolderUpdate,
        actorType: 'user',
        actorId: userId,
        orgId,
        targetType: 'folder',
        targetId: updated.uid,
        targetName: updated.title,
        outcome: 'success',
        metadata: {
          before: { title: existing.title, parentUid: existing.parentUid },
          after: { title: updated.title, parentUid: updated.parentUid },
        },
      });
      return updated;
    } catch (err) {
      if (err instanceof FolderServiceError) throw err;
      throw new FolderServiceError(
        'validation',
        err instanceof Error ? err.message : 'update failed',
        400,
      );
    }
  }

  async delete(
    orgId: string,
    uid: string,
    opts: { forceDeleteRules: boolean; actorId?: string },
  ): Promise<void> {
    const existing = await this.deps.folders.findByUid(orgId, uid);
    if (!existing) {
      throw new FolderServiceError('not_found', `folder not found: ${uid}`, 404);
    }

    const allUids = new Set<string>([uid]);
    for (const d of await this.listDescendantUids(orgId, uid)) allUids.add(d);

    // Alert rule dependents gate (unless forceDeleteRules).
    const ruleCount = await this.countAlertRulesInFolders(orgId, [...allUids]);
    if (ruleCount > 0 && !opts.forceDeleteRules) {
      throw new FolderServiceError(
        'has_dependents',
        `folder contains ${ruleCount} alert rule(s); use forceDeleteRules=true to delete anyway`,
        400,
      );
    }

    // Cascade delete inside a single transaction. We use the QueryClient's
    // `withTransaction` primitive so Postgres pins every statement to one
    // pool connection (raw BEGIN/COMMIT on `pool.query` would route across
    // connections and partially commit). We run all mutations through `tx`
    // — including the folder-row deletes — and skip the FolderRepository
    // helpers here because they go back through the unbound `db`.
    const uidList = [...allUids];
    await this.deps.db.withTransaction(async (tx) => {
      for (const u of uidList) {
        await tx.run(
          sql`DELETE FROM dashboards WHERE org_id = ${orgId} AND folder_uid = ${u}`,
        );
        await tx.run(
          sql`DELETE FROM alert_rules WHERE org_id = ${orgId} AND folder_uid = ${u}`,
        );
        // Legacy ACL rows are keyed on the folder id; resolve uid → id on the
        // tx connection.
        const folderRows = await tx.all<{ id: string }>(
          sql`SELECT id FROM folder WHERE org_id = ${orgId} AND uid = ${u}`,
        );
        if (folderRows[0]) {
          await tx.run(
            sql`DELETE FROM dashboard_acl WHERE org_id = ${orgId} AND folder_id = ${folderRows[0].id}`,
          );
        }
      }
      // Delete the folder rows themselves, children-first.
      for (const u of uidList.slice().reverse()) {
        await tx.run(
          sql`DELETE FROM folder WHERE org_id = ${orgId} AND uid = ${u}`,
        );
      }
    });
    void this.deps.audit?.log({
      action: AuditAction.FolderDelete,
      actorType: 'user',
      actorId: opts.actorId ?? null,
      orgId,
      targetType: 'folder',
      targetId: existing.uid,
      targetName: existing.title,
      outcome: 'success',
      metadata: { cascadedUids: uidList, forceDeleteRules: opts.forceDeleteRules },
    });
  }

  async getParents(orgId: string, uid: string): Promise<GrafanaFolder[]> {
    const ancestors = await this.deps.folders.listAncestors(orgId, uid);
    // listAncestors returns direct-parent first; breadcrumbs want root first.
    return ancestors.slice().reverse();
  }

  async getChildren(orgId: string, uid: string): Promise<GrafanaFolder[]> {
    const existing = await this.deps.folders.findByUid(orgId, uid);
    if (!existing) {
      throw new FolderServiceError('not_found', `folder not found: ${uid}`, 404);
    }
    return this.deps.folders.listChildren(orgId, uid);
  }

  async getCounts(orgId: string, uid: string): Promise<FolderCounts> {
    const existing = await this.deps.folders.findByUid(orgId, uid);
    if (!existing) {
      throw new FolderServiceError('not_found', `folder not found: ${uid}`, 404);
    }
    const dashRows = await this.deps.db.all<{ n: number }>(
      sql`SELECT COUNT(*) AS n FROM dashboards WHERE org_id = ${orgId} AND folder_uid = ${uid}`,
    );
    const ruleRows = await this.deps.db.all<{ n: number }>(
      sql`SELECT COUNT(*) AS n FROM alert_rules WHERE org_id = ${orgId} AND folder_uid = ${uid}`,
    );
    const subRows = await this.deps.db.all<{ n: number }>(
      sql`SELECT COUNT(*) AS n FROM folder WHERE org_id = ${orgId} AND parent_uid = ${uid}`,
    );
    return {
      dashboards: dashRows[0]?.n ?? 0,
      alertRules: ruleRows[0]?.n ?? 0,
      subfolders: subRows[0]?.n ?? 0,
    };
  }

  /**
   * Wave 1 / PR-C: Return the caller's personal "My Workspace" folder, creating
   * it lazily on first access. The folder uid is deterministic (`user:<userId>`)
   * so subsequent calls return the same row even across processes.
   *
   * This is the *only* path that mints a `kind='personal'` folder — the public
   * `create()` rejects the kind so attackers can't impersonate someone else's
   * workspace by guessing the uid.
   */
  async getOrCreatePersonal(
    orgId: string,
    userId: string,
    userDisplayName: string,
  ): Promise<GrafanaFolder> {
    const wantedUid = personalFolderUid(userId);
    const existing = await this.deps.folders.findByUid(orgId, wantedUid);
    if (existing) return existing;
    // Defensive: a caller could ask for someone else's workspace if userId is
    // ever spoofed. The caller (workspace route) is responsible for passing
    // `req.auth.userId` — we just persist it.
    const title = `${userDisplayName}'s workspace`;
    return this.deps.folders.create({
      uid: wantedUid,
      orgId,
      title,
      description: 'Personal workspace — only you can see items here.',
      parentUid: null,
      kind: 'personal',
      createdBy: userId,
      updatedBy: userId,
    });
  }

  // ── Internal helpers ──────────────────────────────────────────────────────

  /** BFS-walk every descendant UID under `uid`. */
  private async listDescendantUids(
    orgId: string,
    uid: string,
  ): Promise<Set<string>> {
    const out = new Set<string>();
    const stack: string[] = [uid];
    while (stack.length) {
      const current = stack.pop()!;
      const children = await this.deps.folders.listChildren(orgId, current);
      for (const c of children) {
        if (!out.has(c.uid)) {
          out.add(c.uid);
          stack.push(c.uid);
        }
      }
    }
    return out;
  }

  /** Depth of the subtree rooted at `uid` (1 = leaf). */
  private async measureSubtreeDepth(orgId: string, uid: string): Promise<number> {
    const children = await this.deps.folders.listChildren(orgId, uid);
    if (children.length === 0) return 1;
    let best = 0;
    for (const c of children) {
      const d = await this.measureSubtreeDepth(orgId, c.uid);
      if (d > best) best = d;
    }
    return best + 1;
  }

  /** Count alert rules inside any of the given folder UIDs (org-scoped). */
  private async countAlertRulesInFolders(orgId: string, uids: string[]): Promise<number> {
    if (uids.length === 0) return 0;
    const placeholders = sql.join(
      uids.map((u) => sql`${u}`),
      sql`, `,
    );
    const rows = await this.deps.db.all<{ n: number }>(sql`
      SELECT COUNT(*) AS n FROM alert_rules
      WHERE org_id = ${orgId} AND folder_uid IN (${placeholders})
    `);
    return rows[0]?.n ?? 0;
  }
}
