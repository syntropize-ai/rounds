/**
 * FolderService unit tests (T7.1).
 *
 * Mirrors the scenarios called out in docs/auth-perm-design/07-resource-permissions.md
 * §test-scenarios (1, 2, 5, 7, 8, 9, 13, 14). Each test uses a fresh
 * in-memory SQLite via `createTestDb` — no fixtures shared across cases.
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
import { FolderService, FolderServiceError, slugifyUid } from './folder-service.js';

function makeService(db: SqliteClient): FolderService {
  return new FolderService({ folders: new FolderRepository(db), db });
}

let adminId = '';

async function bootstrap(db: SqliteClient): Promise<void> {
  await seedDefaultOrg(db);
  const seeded = await seedServerAdmin(db);
  adminId = seeded.user.id;
}

async function seedFolder(
  svc: FolderService,
  title: string,
  parentUid?: string,
): Promise<string> {
  const f = await svc.create(
    'org_main',
    { title, parentUid: parentUid ?? null },
    adminId,
  );
  return f.uid;
}

describe('FolderService.create', () => {
  let db: SqliteClient;
  beforeEach(async () => {
    db = createTestDb();
    await bootstrap(db);
  });

  it('creates a root folder with slugified uid when none given', async () => {
    const svc = makeService(db);
    const folder = await svc.create(
      'org_main',
      { title: 'My Dashboards!' },
      adminId,
    );
    expect(folder.uid).toBe('my_dashboards');
    expect(folder.title).toBe('My Dashboards!');
    expect(folder.parentUid).toBeNull();
  });

  it('respects an explicit uid', async () => {
    const svc = makeService(db);
    const folder = await svc.create(
      'org_main',
      { uid: 'custom-uid', title: 'Custom' },
      adminId,
    );
    expect(folder.uid).toBe('custom-uid');
  });

  it('rejects duplicate explicit uid with 409', async () => {
    const svc = makeService(db);
    await svc.create('org_main', { uid: 'dup', title: 'A' }, adminId);
    await expect(
      svc.create('org_main', { uid: 'dup', title: 'B' }, adminId),
    ).rejects.toThrow(FolderServiceError);
  });

  it('rejects missing title', async () => {
    const svc = makeService(db);
    await expect(
      svc.create('org_main', { title: '' }, adminId),
    ).rejects.toThrow(/title/);
  });

  it('rejects unknown parentUid', async () => {
    const svc = makeService(db);
    await expect(
      svc.create('org_main', { title: 'x', parentUid: 'nope' }, adminId),
    ).rejects.toThrow(/parent folder not found/);
  });

  it('allows nesting up to 8 levels (matches FOLDER_MAX_DEPTH)', async () => {
    const svc = makeService(db);
    let parent: string | null = null;
    for (let i = 1; i <= 8; i++) {
      const uid = await seedFolder(svc, `level_${i}`, parent ?? undefined);
      parent = uid;
    }
    // Depth = 8 is allowed; attempting depth 9 throws.
    await expect(
      svc.create('org_main', { title: 'level_9', parentUid: parent! }, adminId),
    ).rejects.toThrow();
  });
});

describe('FolderService.list', () => {
  let db: SqliteClient;
  beforeEach(async () => {
    db = createTestDb();
    await bootstrap(db);
  });

  it('lists roots when parentUid is null', async () => {
    const svc = makeService(db);
    await seedFolder(svc, 'Alpha');
    await seedFolder(svc, 'Beta');
    const roots = await svc.list('org_main', { parentUid: null });
    expect(roots.map((f) => f.title).sort()).toEqual(['Alpha', 'Beta']);
  });

  it('lists children of a specific parent', async () => {
    const svc = makeService(db);
    const a = await seedFolder(svc, 'Parent');
    await seedFolder(svc, 'Child1', a);
    await seedFolder(svc, 'Child2', a);
    const children = await svc.list('org_main', { parentUid: a });
    expect(children).toHaveLength(2);
  });

  it('filters by query (case-insensitive)', async () => {
    const svc = makeService(db);
    await seedFolder(svc, 'Production Dashboards');
    await seedFolder(svc, 'Staging');
    const hits = await svc.list('org_main', { query: 'PROD' });
    expect(hits.map((f) => f.title)).toEqual(['Production Dashboards']);
  });
});

describe('FolderService.update — move + cycle + depth', () => {
  let db: SqliteClient;
  beforeEach(async () => {
    db = createTestDb();
    await bootstrap(db);
  });

  it('renames a folder', async () => {
    const svc = makeService(db);
    const uid = await seedFolder(svc, 'OldName');
    const patched = await svc.update(
      'org_main',
      uid,
      { title: 'NewName' },
      adminId,
    );
    expect(patched.title).toBe('NewName');
    expect(patched.updatedBy).toBe(adminId);
  });

  it('moves a folder to a new parent', async () => {
    const svc = makeService(db);
    const a = await seedFolder(svc, 'A');
    const b = await seedFolder(svc, 'B');
    const c = await seedFolder(svc, 'C', a);
    const moved = await svc.update(
      'org_main',
      c,
      { parentUid: b },
      adminId,
    );
    expect(moved.parentUid).toBe(b);
  });

  it('rejects cycle — moving a folder under its own descendant', async () => {
    const svc = makeService(db);
    const a = await seedFolder(svc, 'A');
    const b = await seedFolder(svc, 'B', a);
    await expect(
      svc.update('org_main', a, { parentUid: b }, adminId),
    ).rejects.toThrow(/descendant/);
  });

  it('rejects self-parenting', async () => {
    const svc = makeService(db);
    const a = await seedFolder(svc, 'A');
    await expect(
      svc.update('org_main', a, { parentUid: a }, adminId),
    ).rejects.toThrow(/its own parent/);
  });

  it('returns 404 for unknown uid', async () => {
    const svc = makeService(db);
    await expect(
      svc.update('org_main', 'nope', { title: 'x' }, adminId),
    ).rejects.toMatchObject({ statusCode: 404 });
  });
});

describe('FolderService.delete', () => {
  let db: SqliteClient;
  beforeEach(async () => {
    db = createTestDb();
    await bootstrap(db);
  });

  it('deletes an empty folder', async () => {
    const svc = makeService(db);
    const uid = await seedFolder(svc, 'Empty');
    await svc.delete('org_main', uid, { forceDeleteRules: false });
    const after = await svc.getByUid('org_main', uid);
    expect(after).toBeNull();
  });

  it('cascades to sub-folders and dashboards', async () => {
    const svc = makeService(db);
    const root = await seedFolder(svc, 'Root');
    const child = await seedFolder(svc, 'Child', root);
    // Insert a dashboard inside `child`.
    db.run(sql`
      INSERT INTO dashboards (
        id, type, title, description, prompt, user_id, status,
        panels, variables, refresh_interval_sec, datasource_ids,
        use_existing_metrics, created_at, updated_at, org_id, folder_uid
      ) VALUES (
        'd1', 'dashboard', 'D', '', '', 'u', 'ready',
        '[]', '[]', 30, '[]', 1,
        '2026-04-17T00:00:00Z', '2026-04-17T00:00:00Z',
        'org_main', ${child}
      )
    `);
    await svc.delete('org_main', root, { forceDeleteRules: false });
    const dash = db.all<{ n: number }>(
      sql`SELECT COUNT(*) AS n FROM dashboards WHERE id = 'd1'`,
    );
    expect(dash[0]?.n).toBe(0);
    const after = await svc.getByUid('org_main', child);
    expect(after).toBeNull();
  });

  it('refuses delete when folder contains alert rules (forceDeleteRules=false)', async () => {
    const svc = makeService(db);
    const uid = await seedFolder(svc, 'Alerts');
    db.run(sql`
      INSERT INTO alert_rules (
        id, name, description, condition, evaluation_interval_sec,
        severity, state, state_changed_at, created_by,
        fire_count, created_at, updated_at, org_id, folder_uid
      ) VALUES (
        'r1', 'Rule', '', 'true', 60, 'warning', 'normal',
        '2026-04-17T00:00:00Z', 'u', 0,
        '2026-04-17T00:00:00Z', '2026-04-17T00:00:00Z',
        'org_main', ${uid}
      )
    `);
    await expect(
      svc.delete('org_main', uid, { forceDeleteRules: false }),
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it('deletes folder + rules when forceDeleteRules=true', async () => {
    const svc = makeService(db);
    const uid = await seedFolder(svc, 'Alerts2');
    db.run(sql`
      INSERT INTO alert_rules (
        id, name, description, condition, evaluation_interval_sec,
        severity, state, state_changed_at, created_by,
        fire_count, created_at, updated_at, org_id, folder_uid
      ) VALUES (
        'r2', 'R', '', 'true', 60, 'warning', 'normal',
        '2026-04-17T00:00:00Z', 'u', 0,
        '2026-04-17T00:00:00Z', '2026-04-17T00:00:00Z',
        'org_main', ${uid}
      )
    `);
    await svc.delete('org_main', uid, { forceDeleteRules: true });
    const rules = db.all<{ n: number }>(
      sql`SELECT COUNT(*) AS n FROM alert_rules WHERE org_id = 'org_main' AND folder_uid = ${uid}`,
    );
    expect(rules[0]?.n).toBe(0);
  });

  it('returns 404 for unknown uid', async () => {
    const svc = makeService(db);
    await expect(
      svc.delete('org_main', 'nope', { forceDeleteRules: false }),
    ).rejects.toMatchObject({ statusCode: 404 });
  });
});

describe('FolderService.getParents / getChildren / getCounts', () => {
  let db: SqliteClient;
  beforeEach(async () => {
    db = createTestDb();
    await bootstrap(db);
  });

  it('returns breadcrumb chain root-first', async () => {
    const svc = makeService(db);
    const a = await seedFolder(svc, 'A');
    const b = await seedFolder(svc, 'B', a);
    const c = await seedFolder(svc, 'C', b);
    const parents = await svc.getParents('org_main', c);
    expect(parents.map((f) => f.uid)).toEqual([a, b]);
  });

  it('counts direct dashboards + subfolders + alertRules', async () => {
    const svc = makeService(db);
    const uid = await seedFolder(svc, 'Root');
    await seedFolder(svc, 'Child', uid);
    db.run(sql`
      INSERT INTO dashboards (
        id, type, title, description, prompt, user_id, status,
        panels, variables, refresh_interval_sec, datasource_ids,
        use_existing_metrics, created_at, updated_at, org_id, folder_uid
      ) VALUES (
        'dx', 'dashboard', 'X', '', '', 'u', 'ready',
        '[]', '[]', 30, '[]', 1,
        '2026-04-17T00:00:00Z', '2026-04-17T00:00:00Z',
        'org_main', ${uid}
      )
    `);
    const counts = await svc.getCounts('org_main', uid);
    expect(counts.dashboards).toBe(1);
    expect(counts.subfolders).toBe(1);
    expect(counts.alertRules).toBe(0);
  });
});

describe('FolderService.list counts', () => {
  let db: SqliteClient;
  beforeEach(async () => {
    db = createTestDb();
    await bootstrap(db);
  });

  it('returns mixed-resource counts per folder (RFC-1)', async () => {
    const svc = makeService(db);
    const alertsOnly = await seedFolder(svc, 'Alerts Only');
    const empty = await seedFolder(svc, 'Empty');
    // Two alert rules in `alertsOnly`, zero dashboards.
    for (const id of ['ar1', 'ar2']) {
      db.run(sql`
        INSERT INTO alert_rules (
          id, name, description, condition, evaluation_interval_sec,
          severity, state, state_changed_at, created_by,
          fire_count, created_at, updated_at, org_id, folder_uid
        ) VALUES (
          ${id}, ${id}, '', 'true', 60, 'warning', 'normal',
          '2026-04-17T00:00:00Z', 'u', 0,
          '2026-04-17T00:00:00Z', '2026-04-17T00:00:00Z',
          'org_main', ${alertsOnly}
        )
      `);
    }
    const items = await svc.list('org_main', { parentUid: null });
    const a = items.find((f) => f.uid === alertsOnly)!;
    const e = items.find((f) => f.uid === empty)!;
    expect(a.counts).toEqual({ dashboards: 0, alertRules: 2, subfolders: 0 });
    expect(e.counts).toEqual({ dashboards: 0, alertRules: 0, subfolders: 0 });
  });
});

describe('slugifyUid', () => {
  it('lowercases and replaces non-alnum runs with _', () => {
    expect(slugifyUid('Hello World!')).toBe('hello_world');
  });

  it('trims leading/trailing _', () => {
    expect(slugifyUid('!!!hi!!!')).toBe('hi');
  });

  it('truncates at 40 characters', () => {
    const s = slugifyUid('a'.repeat(60));
    expect(s.length).toBeLessThanOrEqual(40);
  });

  it('falls back to a random token for empty results', () => {
    const s = slugifyUid('!!!');
    expect(s.startsWith('folder_')).toBe(true);
  });
});
