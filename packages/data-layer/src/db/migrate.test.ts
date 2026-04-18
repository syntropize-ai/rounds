import { describe, it, expect } from 'vitest';
import { sql } from 'drizzle-orm';
import { createSqliteClient } from './sqlite-client.js';
import { migrate, applyNamedMigrations, splitSqlStatements } from './migrate.js';

describe('migrate()', () => {
  it('creates every auth/perm table on a fresh in-memory DB', () => {
    const db = createSqliteClient({ path: ':memory:', wal: false });
    migrate(db);

    const expected = [
      'org', 'user', 'user_auth', 'user_auth_token',
      'org_user', 'team', 'team_member', 'api_key',
      'role', 'permission', 'builtin_role', 'user_role', 'team_role',
      'folder', 'dashboard_acl', 'preferences', 'quota', 'audit_log',
    ];

    const rows = db.all<{ name: string }>(sql`SELECT name FROM sqlite_master WHERE type='table'`);
    const names = new Set(rows.map((r) => r.name));
    for (const t of expected) {
      expect(names, `expected table ${t}`).toContain(t);
    }
  });

  it('seeds org_main via 001_org.sql', () => {
    const db = createSqliteClient({ path: ':memory:', wal: false });
    migrate(db);
    const rows = db.all<{ id: string; name: string }>(sql`SELECT id, name FROM org WHERE id = 'org_main'`);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.name).toBe('Main Org');
  });

  it('adds org_id to existing resource tables (015_alter_resources.sql)', () => {
    const db = createSqliteClient({ path: ':memory:', wal: false });
    migrate(db);

    // dashboards is created by the legacy migration; verify org_id was added.
    const cols = db.all<{ name: string }>(sql.raw(`PRAGMA table_info(dashboards)`));
    const colNames = new Set(cols.map((c) => c.name));
    expect(colNames).toContain('org_id');
    expect(colNames).toContain('workspace_id'); // legacy col left in place
  });

  it('is idempotent — second migrate() is a no-op', () => {
    const db = createSqliteClient({ path: ':memory:', wal: false });
    migrate(db);
    const firstCount = db.all<{ n: number }>(sql`SELECT COUNT(*) AS n FROM _migrations`)[0]!.n;
    migrate(db);
    const secondCount = db.all<{ n: number }>(sql`SELECT COUNT(*) AS n FROM _migrations`)[0]!.n;
    expect(secondCount).toBe(firstCount);
  });

  it('applied-names reflect every SQL file', () => {
    const db = createSqliteClient({ path: ':memory:', wal: false });
    migrate(db);
    const rows = db.all<{ name: string }>(
      sql`SELECT name FROM _migrations WHERE name IS NOT NULL ORDER BY name`,
    );
    const names = rows.map((r) => r.name);
    expect(names).toEqual([
      '001_org.sql',
      '002_user.sql',
      '003_user_auth.sql',
      '004_user_auth_token.sql',
      '005_org_user.sql',
      '006_team.sql',
      '007_team_member.sql',
      '008_api_key.sql',
      '009_rbac.sql',
      '010_folder.sql',
      '011_dashboard_acl.sql',
      '012_preferences.sql',
      '013_quota.sql',
      '014_audit_log.sql',
      '015_alter_resources.sql',
      '016_drop_workspaces.sql',
      '017_dashboard_folder_uid.sql',
    ]);
  });

  it('applyNamedMigrations can be called with a custom list', () => {
    const db = createSqliteClient({ path: ':memory:', wal: false });
    // Run base schema first, otherwise ALTER TABLE on 015_alter_resources has nothing to alter.
    migrate(db);
    // Re-applying with empty list is a no-op.
    applyNamedMigrations(db, []);
    const rows = db.all<{ n: number }>(sql`SELECT COUNT(*) AS n FROM _migrations`);
    expect(rows[0]!.n).toBeGreaterThan(0);
  });
});

describe('splitSqlStatements()', () => {
  it('splits simple DDL', () => {
    const out = splitSqlStatements(`
      CREATE TABLE a (id TEXT);
      CREATE TABLE b (id TEXT);
    `);
    expect(out).toEqual(['CREATE TABLE a (id TEXT)', 'CREATE TABLE b (id TEXT)']);
  });

  it('strips -- line comments', () => {
    const out = splitSqlStatements(`
      -- leading comment
      CREATE TABLE a (
        id TEXT -- inline
      );
    `);
    expect(out).toHaveLength(1);
    expect(out[0]).toContain('CREATE TABLE a');
    expect(out[0]).not.toContain('inline');
  });

  it('ignores empty / whitespace-only statements', () => {
    const out = splitSqlStatements(`;;  ;\nCREATE TABLE a (id TEXT);\n;`);
    expect(out).toEqual(['CREATE TABLE a (id TEXT)']);
  });
});
