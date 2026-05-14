/**
 * Workspace-folder tests for FolderService (Wave 1 / PR-C).
 *
 * Covers the personal-kind flow:
 *   - `getOrCreatePersonal` is idempotent (lazy create then return).
 *   - public `create()` rejects `kind: 'personal'`.
 *   - `list(...)` hides personal folders from anyone but the owner.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { sql } from 'drizzle-orm';
import {
  createTestDb,
  seedDefaultOrg,
  seedServerAdmin,
  FolderRepository,
} from '@agentic-obs/data-layer';
import type { SqliteClient } from '@agentic-obs/data-layer';
import { FolderService, FolderServiceError } from './folder-service.js';

function makeService(db: SqliteClient): FolderService {
  return new FolderService({ folders: new FolderRepository(db), db });
}

let adminId = '';

async function bootstrap(db: SqliteClient): Promise<void> {
  await seedDefaultOrg(db);
  const seeded = await seedServerAdmin(db);
  adminId = seeded.user.id;
}

describe('FolderService — personal workspace (Wave 1 / PR-C)', () => {
  let db: SqliteClient;
  beforeEach(async () => {
    db = createTestDb();
    await bootstrap(db);
  });

  it('lazy-creates the personal folder on first call', async () => {
    const svc = makeService(db);
    const folder = await svc.getOrCreatePersonal('org_main', adminId, 'Ada');
    expect(folder.uid).toBe(`user:${adminId}`);
    expect(folder.kind).toBe('personal');
    expect(folder.title).toBe("Ada's workspace");
    expect(folder.parentUid).toBeNull();
  });

  it('returns the same folder on a second call (idempotent)', async () => {
    const svc = makeService(db);
    const a = await svc.getOrCreatePersonal('org_main', adminId, 'Ada');
    const b = await svc.getOrCreatePersonal('org_main', adminId, 'Different Name');
    expect(b.id).toBe(a.id);
    // Title is not retro-renamed — first call wins. Acceptable for v1.
    expect(b.title).toBe("Ada's workspace");
  });

  it('rejects public create() with kind=personal', async () => {
    const svc = makeService(db);
    await expect(
      svc.create(
        'org_main',
        { title: 'evil', kind: 'personal' },
        adminId,
      ),
    ).rejects.toThrow(FolderServiceError);
  });

  it("hides other users' personal folders from list()", async () => {
    const svc = makeService(db);
    // Two users in the same org. The seeded admin is user A; we make a second
    // user by directly inserting (FolderRepository.create enforces a FK to
    // users on created_by). Using `null` createdBy on the personal folders
    // avoids the FK entirely for the synthetic second principal.
    const aId = adminId;
    const bId = `${adminId}-other`; // not a real user — folder allows null createdBy
    // user A's personal folder.
    await svc.getOrCreatePersonal('org_main', aId, 'Alice');
    // user B's personal folder — bypass createdBy FK by mutating the row.
    // We can call findByUid which returns null, then exercise the lazy path
    // via getOrCreatePersonal but with the real-admin id as creator on the row
    // to satisfy FK. The folder's identity (and ownership) is its uid.
    const bTitle = `Bob's workspace`;
    const now = new Date().toISOString();
    await db.run(sql`
      INSERT INTO folder (id, uid, org_id, title, description, parent_uid, kind, created, updated, created_by, updated_by)
      VALUES ('f_b', ${`user:${bId}`}, 'org_main', ${bTitle}, NULL, NULL, 'personal',
              ${now}, ${now}, NULL, NULL)
    `);
    // A shared folder visible to both.
    await svc.create('org_main', { title: 'Team' }, adminId);

    // user A only sees their own personal folder plus shared.
    const asA = await svc.list('org_main', { parentUid: null }, aId);
    const uidsA = asA.map((f) => f.uid);
    expect(uidsA).toContain(`user:${aId}`);
    expect(uidsA).not.toContain(`user:${bId}`);
    expect(uidsA).toContain('team');

    // user B inverse.
    const asB = await svc.list('org_main', { parentUid: null }, bId);
    const uidsB = asB.map((f) => f.uid);
    expect(uidsB).toContain(`user:${bId}`);
    expect(uidsB).not.toContain(`user:${aId}`);
  });
});
