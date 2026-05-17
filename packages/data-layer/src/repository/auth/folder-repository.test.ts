import { describe, it, expect, beforeEach } from 'vitest';
import { sql } from 'drizzle-orm';
import type { SqliteClient } from '../../db/sqlite-client.js';
import { createTestDb } from '../../test-support/test-db.js';
import { FolderRepository } from './folder-repository.js';

describe('FolderRepository', () => {
  let db: SqliteClient;
  let repo: FolderRepository;

  beforeEach(() => {
    db = createTestDb();
    repo = new FolderRepository(db);
  });

  it('create() inserts a root folder', async () => {
    const f = await repo.create({ orgId: 'org_main', uid: 'root', title: 'Root' });
    expect(f.uid).toBe('root');
    expect(f.parentUid).toBeNull();
  });

  it('create() under a known parent succeeds', async () => {
    await repo.create({ orgId: 'org_main', uid: 'p', title: 'Parent' });
    const child = await repo.create({
      orgId: 'org_main', uid: 'c', title: 'Child', parentUid: 'p',
    });
    expect(child.parentUid).toBe('p');
  });

  it('create() under an unknown parent throws', async () => {
    await expect(
      repo.create({ orgId: 'org_main', uid: 'c', title: 'Child', parentUid: 'missing' }),
    ).rejects.toThrow(/parent folder not found/);
  });

  it('findByUid() returns the folder', async () => {
    await repo.create({ orgId: 'org_main', uid: 'f', title: 'F' });
    expect((await repo.findByUid('org_main', 'f'))!.title).toBe('F');
  });

  it('drops corrupt provenance without dropping the folder', async () => {
    await repo.create({ orgId: 'org_main', uid: 'bad-prov', title: 'Bad provenance' });
    db.run(sql`
      UPDATE folder
      SET provenance = ${'{bad json'}
      WHERE org_id = ${'org_main'} AND uid = ${'bad-prov'}
    `);

    const folder = await repo.findByUid('org_main', 'bad-prov');
    expect(folder).toMatchObject({ uid: 'bad-prov', title: 'Bad provenance' });
    expect(folder?.provenance).toBeUndefined();
  });

  it('listAncestors() returns parent chain root-last', async () => {
    await repo.create({ orgId: 'org_main', uid: 'a', title: 'A' });
    await repo.create({ orgId: 'org_main', uid: 'b', title: 'B', parentUid: 'a' });
    await repo.create({ orgId: 'org_main', uid: 'c', title: 'C', parentUid: 'b' });
    const chain = await repo.listAncestors('org_main', 'c');
    expect(chain.map((f) => f.uid)).toEqual(['b', 'a']);
  });

  it('listChildren() lists direct descendants', async () => {
    await repo.create({ orgId: 'org_main', uid: 'p', title: 'P' });
    await repo.create({ orgId: 'org_main', uid: 'c1', title: 'c1', parentUid: 'p' });
    await repo.create({ orgId: 'org_main', uid: 'c2', title: 'c2', parentUid: 'p' });
    expect(await repo.listChildren('org_main', 'p')).toHaveLength(2);
  });

  it('listChildren() of root returns top-level folders', async () => {
    await repo.create({ orgId: 'org_main', uid: 't1', title: 't1' });
    await repo.create({ orgId: 'org_main', uid: 't2', title: 't2' });
    expect(await repo.listChildren('org_main', null)).toHaveLength(2);
  });

  it('update() changes title', async () => {
    const f = await repo.create({ orgId: 'org_main', uid: 'u', title: 'old' });
    const updated = await repo.update(f.id, { title: 'new' });
    expect(updated!.title).toBe('new');
  });

  it('update() rejects moving under a descendant (cycle)', async () => {
    await repo.create({ orgId: 'org_main', uid: 'a', title: 'A' });
    const b = await repo.create({
      orgId: 'org_main', uid: 'b', title: 'B', parentUid: 'a',
    });
    // Moving A under B would create a->b->a cycle.
    const a = (await repo.findByUid('org_main', 'a'))!;
    await expect(repo.update(a.id, { parentUid: b.uid })).rejects.toThrow(/cycle/);
  });

  it('create() enforces max depth', async () => {
    // Build a chain up to the limit. FOLDER_MAX_DEPTH = 8 means at most 8
    // parent links above a folder (9-deep chain counting the root).
    // After 9 folders the 10th should fail.
    let parentUid: string | null = null;
    for (let i = 0; i < 9; i++) {
      const uidVal = `f${i}`;
      await repo.create({
        orgId: 'org_main', uid: uidVal, title: uidVal,
        parentUid: parentUid,
      });
      parentUid = uidVal;
    }
    await expect(
      repo.create({ orgId: 'org_main', uid: 'too_deep', title: 'X', parentUid: parentUid! }),
    ).rejects.toThrow(/depth/);
  });

  it('delete() removes a folder', async () => {
    const f = await repo.create({ orgId: 'org_main', uid: 'd', title: 'D' });
    expect(await repo.delete(f.id)).toBe(true);
    expect(await repo.findById(f.id)).toBeNull();
  });

  it('unique (orgId, uid) rejects duplicates', async () => {
    await repo.create({ orgId: 'org_main', uid: 'dup', title: 'D' });
    await expect(
      repo.create({ orgId: 'org_main', uid: 'dup', title: 'D2' }),
    ).rejects.toThrow();
  });
});
