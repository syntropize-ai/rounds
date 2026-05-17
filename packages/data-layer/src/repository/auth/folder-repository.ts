import { sql, type SQL } from 'drizzle-orm';
import { createLogger } from '@agentic-obs/server-utils/logging';
import type { SqliteClient } from '../../db/sqlite-client.js';
import type { IFolderRepository, ListFoldersOptions, Page } from '@agentic-obs/common';
import type {
  GrafanaFolder,
  NewGrafanaFolder,
  GrafanaFolderPatch,
  ResourceSource,
  ResourceProvenance,
} from '@agentic-obs/common';
import { FOLDER_MAX_DEPTH } from '@agentic-obs/common';
import { uid, nowIso } from './shared.js';

const log = createLogger('folder-repository');

interface Row {
  id: string;
  uid: string;
  org_id: string;
  title: string;
  description: string | null;
  parent_uid: string | null;
  created: string;
  updated: string;
  created_by: string | null;
  updated_by: string | null;
  source: string;
  provenance: string | null;
}

function rowTo(r: Row): GrafanaFolder {
  let provenance: ResourceProvenance | undefined;
  if (r.provenance) {
    try {
      const parsed = JSON.parse(r.provenance);
      if (parsed && typeof parsed === 'object') provenance = parsed as ResourceProvenance;
    } catch (err) {
      log.warn(
        { err, folderId: r.id, folderUid: r.uid, orgId: r.org_id },
        'folder provenance JSON parse failed; dropping provenance',
      );
    }
  }
  const f: GrafanaFolder = {
    id: r.id,
    uid: r.uid,
    orgId: r.org_id,
    title: r.title,
    description: r.description,
    parentUid: r.parent_uid,
    created: r.created,
    updated: r.updated,
    createdBy: r.created_by,
    updatedBy: r.updated_by,
    source: (r.source ?? 'manual') as ResourceSource,
  };
  if (provenance) f.provenance = provenance;
  return f;
}

/**
 * Folder repo for the Grafana-parity hierarchical folder. Enforces:
 *
 *  - max depth 8 (matches grafana's cap — see 01-database-schema.md §folder),
 *  - parent-must-exist,
 *  - no cycles (when moving a folder under one of its descendants).
 *
 * Referential invariants live in application code because SQLite FK enforcement
 * on `parent_uid` would require a second FK to a TEXT column, which sqlite
 * doesn't support well on composite (org_id, uid) parents.
 */
export class FolderRepository implements IFolderRepository {
  constructor(private readonly db: SqliteClient) {}

  async create(input: NewGrafanaFolder): Promise<GrafanaFolder> {
    if (input.parentUid) {
      await this.assertParentAndDepth(input.orgId, input.parentUid);
    }
    const id = input.id ?? uid();
    const now = nowIso();
    const source: ResourceSource = input.source ?? 'manual';
    const provenanceJson = input.provenance ? JSON.stringify(input.provenance) : null;
    this.db.run(sql`
      INSERT INTO folder (
        id, uid, org_id, title, description, parent_uid,
        created, updated, created_by, updated_by,
        source, provenance
      ) VALUES (
        ${id}, ${input.uid}, ${input.orgId}, ${input.title},
        ${input.description ?? null}, ${input.parentUid ?? null},
        ${now}, ${now}, ${input.createdBy ?? null}, ${input.updatedBy ?? null},
        ${source}, ${provenanceJson}
      )
    `);
    const row = await this.findById(id);
    if (!row) throw new Error(`[FolderRepository] create failed for id=${id}`);
    return row;
  }

  async findById(id: string): Promise<GrafanaFolder | null> {
    const rows = this.db.all<Row>(sql`SELECT * FROM folder WHERE id = ${id}`);
    return rows[0] ? rowTo(rows[0]) : null;
  }

  async findByUid(orgId: string, uidVal: string): Promise<GrafanaFolder | null> {
    const rows = this.db.all<Row>(
      sql`SELECT * FROM folder WHERE org_id = ${orgId} AND uid = ${uidVal}`,
    );
    return rows[0] ? rowTo(rows[0]) : null;
  }

  async list(opts: ListFoldersOptions): Promise<Page<GrafanaFolder>> {
    const limit = opts.limit ?? 200;
    const offset = opts.offset ?? 0;
    const wheres: SQL[] = [sql`org_id = ${opts.orgId}`];
    if (opts.parentUid !== undefined) {
      wheres.push(
        opts.parentUid === null
          ? sql`parent_uid IS NULL`
          : sql`parent_uid = ${opts.parentUid}`,
      );
    }
    const whereClause = sql.join([sql`WHERE`, sql.join(wheres, sql` AND `)], sql` `);
    const rows = this.db.all<Row>(sql`
      SELECT * FROM folder ${whereClause}
      ORDER BY title
      LIMIT ${limit} OFFSET ${offset}
    `);
    const totalRows = this.db.all<{ n: number }>(sql`
      SELECT COUNT(*) AS n FROM folder ${whereClause}
    `);
    return { items: rows.map(rowTo), total: totalRows[0]?.n ?? 0 };
  }

  async listAncestors(orgId: string, uidVal: string): Promise<GrafanaFolder[]> {
    const chain: GrafanaFolder[] = [];
    let cursor = await this.findByUid(orgId, uidVal);
    if (!cursor) return chain;
    // Walk parent links with a depth guard — defence against accidental cycles.
    for (let i = 0; i < FOLDER_MAX_DEPTH + 1; i++) {
      if (!cursor.parentUid) break;
      const parent = await this.findByUid(orgId, cursor.parentUid);
      if (!parent) break;
      chain.push(parent);
      cursor = parent;
    }
    return chain;
  }

  async listChildren(orgId: string, parentUid: string | null): Promise<GrafanaFolder[]> {
    const rows =
      parentUid === null
        ? this.db.all<Row>(
            sql`SELECT * FROM folder WHERE org_id = ${orgId} AND parent_uid IS NULL ORDER BY title`,
          )
        : this.db.all<Row>(
            sql`SELECT * FROM folder WHERE org_id = ${orgId} AND parent_uid = ${parentUid} ORDER BY title`,
          );
    return rows.map(rowTo);
  }

  async update(id: string, patch: GrafanaFolderPatch): Promise<GrafanaFolder | null> {
    const existing = await this.findById(id);
    if (!existing) return null;

    if (
      patch.parentUid !== undefined &&
      patch.parentUid !== existing.parentUid &&
      patch.parentUid !== null
    ) {
      // Moving under a new parent — check cycle + depth.
      await this.assertParentAndDepth(existing.orgId, patch.parentUid, existing.uid);
    }

    const now = nowIso();
    const m = {
      title: patch.title ?? existing.title,
      description:
        patch.description !== undefined ? patch.description : existing.description,
      parentUid: patch.parentUid !== undefined ? patch.parentUid : existing.parentUid,
      updatedBy: patch.updatedBy !== undefined ? patch.updatedBy : existing.updatedBy,
    };
    this.db.run(sql`
      UPDATE folder SET
        title = ${m.title},
        description = ${m.description},
        parent_uid = ${m.parentUid},
        updated = ${now},
        updated_by = ${m.updatedBy}
      WHERE id = ${id}
    `);
    return this.findById(id);
  }

  async delete(id: string): Promise<boolean> {
    const before = await this.findById(id);
    if (!before) return false;
    this.db.run(sql`DELETE FROM folder WHERE id = ${id}`);
    return true;
  }

  // — Internal helpers ————————————————————————————————————————

  private async assertParentAndDepth(
    orgId: string,
    parentUid: string,
    movingUid?: string,
  ): Promise<void> {
    const parent = await this.findByUid(orgId, parentUid);
    if (!parent) {
      throw new Error(`[FolderRepository] parent folder not found: ${parentUid}`);
    }
    // Cycle: if we're moving `movingUid` under a new parent whose chain
    // already contains `movingUid`, we'd make movingUid its own ancestor.
    if (movingUid && parent.uid === movingUid) {
      throw new Error(
        `[FolderRepository] cycle detected — ${movingUid} cannot be its own parent`,
      );
    }

    // Depth: parent has `depth` parents already; the new/moved folder would
    // sit at `depth + 1`. FOLDER_MAX_DEPTH is the maximum allowed depth.
    let depth = 1; // one link for `parent` itself above the new folder
    let cursor: GrafanaFolder | null = parent;
    while (cursor?.parentUid) {
      const next: GrafanaFolder | null = await this.findByUid(orgId, cursor.parentUid);
      if (!next) break;
      if (movingUid && next.uid === movingUid) {
        throw new Error(
          `[FolderRepository] cycle detected — ${movingUid} is an ancestor of ${parentUid}`,
        );
      }
      cursor = next;
      depth++;
      if (depth > FOLDER_MAX_DEPTH) {
        throw new Error(
          `[FolderRepository] folder depth would exceed limit of ${FOLDER_MAX_DEPTH}`,
        );
      }
    }
  }
}
