import { eq, isNull } from 'drizzle-orm';
import type { SqliteClient } from '../../db/sqlite-client.js';
import { folders } from '../../db/sqlite-schema.js';
import type { IFolderRepository } from '../interfaces.js';
import type { Folder } from '../types/folder.js';

type DbRow = typeof folders.$inferSelect;

function uid(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function rowToFolder(row: DbRow): Folder {
  return {
    id: row.id,
    name: row.name,
    parentId: row.parentId ?? undefined,
    createdAt: row.createdAt,
  };
}

export class SqliteFolderRepository implements IFolderRepository {
  constructor(private readonly db: SqliteClient) {}

  async create(params: { name: string; parentId?: string }): Promise<Folder> {
    const now = new Date().toISOString();
    const id = uid();
    const [row] = await this.db
      .insert(folders)
      .values({
        id,
        name: params.name.trim(),
        parentId: params.parentId ?? null,
        createdAt: now,
      })
      .returning();
    return rowToFolder(row!);
  }

  async findAll(): Promise<Folder[]> {
    const rows = await this.db.select().from(folders);
    return rows.map(rowToFolder);
  }

  async findById(id: string): Promise<Folder | undefined> {
    const [row] = await this.db.select().from(folders).where(eq(folders.id, id));
    return row ? rowToFolder(row) : undefined;
  }

  async findByParent(parentId?: string): Promise<Folder[]> {
    const rows = parentId
      ? await this.db.select().from(folders).where(eq(folders.parentId, parentId))
      : await this.db.select().from(folders).where(isNull(folders.parentId));
    return rows.map(rowToFolder);
  }

  async rename(id: string, name: string): Promise<Folder | undefined> {
    const [row] = await this.db
      .update(folders)
      .set({ name: name.trim() })
      .where(eq(folders.id, id))
      .returning();
    return row ? rowToFolder(row) : undefined;
  }

  async delete(id: string): Promise<boolean> {
    // Cascade delete children recursively
    const children = await this.findByParent(id);
    for (const child of children) {
      await this.delete(child.id);
    }
    const result = await this.db.delete(folders).where(eq(folders.id, id)).returning();
    return result.length > 0;
  }

  async getPath(id: string): Promise<string> {
    const parts: string[] = [];
    let currentId: string | undefined = id;
    while (currentId) {
      const folder = await this.findById(currentId);
      if (!folder) break;
      parts.unshift(folder.name);
      currentId = folder.parentId;
    }
    return parts.join('/');
  }
}
