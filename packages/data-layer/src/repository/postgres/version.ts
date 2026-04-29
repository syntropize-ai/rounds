import { eq, and, sql } from 'drizzle-orm';
import type { AssetType, AssetVersion, EditSource } from '@agentic-obs/common';
import { assetVersions } from '../../db/sqlite-schema.js';
import type { IVersionRepository } from '../interfaces.js';

type VersionRow = typeof assetVersions.$inferSelect;

function uid(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function rowToVersion(row: VersionRow): AssetVersion {
  return {
    id: row.id,
    assetType: row.assetType as AssetType,
    assetId: row.assetId,
    version: row.version,
    snapshot: row.snapshot,
    diff: row.diff ?? undefined,
    editedBy: row.editedBy,
    editSource: row.editSource as EditSource,
    message: row.message ?? undefined,
    createdAt: row.createdAt,
  };
}

export class PostgresVersionRepository implements IVersionRepository {
  constructor(private readonly db: any) {}

  async record(
    assetType: AssetType,
    assetId: string,
    snapshot: unknown,
    editedBy: string,
    editSource: EditSource,
    message?: string,
  ): Promise<AssetVersion> {
    // Allocate the next version atomically. Read-then-insert across two
    // statements is racy: two writers see the same MAX and pick the same
    // version. We hold a per-(assetType, assetId) advisory lock for the
    // life of the transaction so concurrent record() calls serialize.
    const lockKey = `${assetType}:${assetId}`;
    const id = uid();
    const now = new Date().toISOString();
    const snapshotJson = JSON.stringify(snapshot ?? null);
    return this.db.withTransaction(async (tx: import('../../db/query-client.js').QueryClient) => {
      await tx.run(
        sql`SELECT pg_advisory_xact_lock(hashtext(${lockKey}))`,
      );
      const rows = await tx.all<{ next: number }>(
        sql`SELECT COALESCE(MAX(version), 0) + 1 AS next
            FROM asset_versions
            WHERE asset_type = ${assetType} AND asset_id = ${assetId}`,
      );
      const nextVersion = Number(rows[0]?.next ?? 1);
      await tx.run(
        sql`INSERT INTO asset_versions
            (id, asset_type, asset_id, version, snapshot, edited_by, edit_source, message, created_at)
            VALUES (${id}, ${assetType}, ${assetId}, ${nextVersion}, ${snapshotJson},
                    ${editedBy}, ${editSource}, ${message ?? null}, ${now})`,
      );
      return {
        id,
        assetType,
        assetId,
        version: nextVersion,
        snapshot,
        diff: undefined,
        editedBy,
        editSource,
        message: message ?? undefined,
        createdAt: now,
      };
    });
  }

  async getHistory(assetType: AssetType, assetId: string): Promise<AssetVersion[]> {
    const rows = await this.db
      .select()
      .from(assetVersions)
      .where(
        and(
          eq(assetVersions.assetType, assetType),
          eq(assetVersions.assetId, assetId),
        ),
      )
      .orderBy(sql`${assetVersions.version} desc`);
    return rows.map(rowToVersion);
  }

  async getVersion(assetType: AssetType, assetId: string, version: number): Promise<AssetVersion | undefined> {
    const [row] = await this.db
      .select()
      .from(assetVersions)
      .where(
        and(
          eq(assetVersions.assetType, assetType),
          eq(assetVersions.assetId, assetId),
          eq(assetVersions.version, version),
        ),
      );
    return row ? rowToVersion(row) : undefined;
  }

  async getLatest(assetType: AssetType, assetId: string): Promise<AssetVersion | undefined> {
    const [row] = await this.db
      .select()
      .from(assetVersions)
      .where(
        and(
          eq(assetVersions.assetType, assetType),
          eq(assetVersions.assetId, assetId),
        ),
      )
      .orderBy(sql`${assetVersions.version} desc`)
      .limit(1);
    return row ? rowToVersion(row) : undefined;
  }

  async rollback(assetType: AssetType, assetId: string, version: number): Promise<unknown | undefined> {
    const entry = await this.getVersion(assetType, assetId, version);
    return entry?.snapshot;
  }
}
