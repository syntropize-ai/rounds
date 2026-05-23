import { describe, it, expect } from 'vitest';
import { sql } from 'drizzle-orm';
import { createSqliteClient } from './sqlite-client.js';
import { applySchema, splitSqlStatements } from './schema-applier.js';

describe('applySchema()', () => {
  it('creates every expected table on a fresh in-memory DB', () => {
    const db = createSqliteClient({ path: ':memory:', wal: false });
    applySchema(db);

    const expected = [
      'org', 'users', 'user_auth', 'user_auth_token',
      'org_user', 'team', 'team_member', 'api_key',
      'role', 'permission', 'builtin_role', 'user_role', 'team_role',
      'folder', 'dashboard_acl', 'preferences', 'quota', 'audit_log',
      'instance_llm_config',
      'notification_channels', 'instance_settings',
      'connectors', 'connector_capabilities', 'connector_secrets',
      'connector_policies',
    ];

    const rows = db.all<{ name: string }>(sql`SELECT name FROM sqlite_master WHERE type='table'`);
    const names = new Set(rows.map((r) => r.name));
    for (const t of expected) {
      expect(names, `expected table ${t}`).toContain(t);
    }
  });

  it('seeds org_main', () => {
    const db = createSqliteClient({ path: ':memory:', wal: false });
    applySchema(db);
    const rows = db.all<{ id: string; name: string }>(sql`SELECT id, name FROM org WHERE id = 'org_main'`);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.name).toBe('Main Org');
  });

  it('dashboards has org_id and folder_uid columns', () => {
    const db = createSqliteClient({ path: ':memory:', wal: false });
    applySchema(db);
    const cols = db.all<{ name: string }>(sql.raw(`PRAGMA table_info(dashboards)`));
    const colNames = new Set(cols.map((c) => c.name));
    expect(colNames).toContain('org_id');
    expect(colNames).toContain('folder_uid');
  });

  it('dashboards / alert_rules / folder have source + provenance columns with default `manual`', () => {
    const db = createSqliteClient({ path: ':memory:', wal: false });
    applySchema(db);
    for (const table of ['dashboards', 'alert_rules', 'folder'] as const) {
      const cols = db.all<{ name: string; dflt_value: string | null; notnull: number }>(
        sql.raw(`PRAGMA table_info(${table})`),
      );
      const byName = new Map(cols.map((c) => [c.name, c]));
      expect(byName.has('source'), `${table}.source`).toBe(true);
      expect(byName.has('provenance'), `${table}.provenance`).toBe(true);
      const src = byName.get('source')!;
      expect(src.notnull).toBe(1);
      // SQLite quotes the default literal — accept either form.
      expect(src.dflt_value).toMatch(/'manual'/);
    }
  });

  it('renames legacy `user` table to `users` for pre-rename instances', () => {
    const db = createSqliteClient({ path: ':memory:', wal: false });
    // Simulate a pre-rename database with the old `user` table and one row.
    db.run(sql.raw(`
      CREATE TABLE user (
        id TEXT PRIMARY KEY,
        version INTEGER NOT NULL DEFAULT 0,
        email TEXT NOT NULL, name TEXT NOT NULL, login TEXT NOT NULL,
        password TEXT, salt TEXT, rands TEXT, company TEXT,
        org_id TEXT NOT NULL,
        is_admin INTEGER NOT NULL DEFAULT 0,
        email_verified INTEGER NOT NULL DEFAULT 0,
        theme TEXT, help_flags1 INTEGER NOT NULL DEFAULT 0,
        is_disabled INTEGER NOT NULL DEFAULT 0,
        is_service_account INTEGER NOT NULL DEFAULT 0,
        created TEXT NOT NULL, updated TEXT NOT NULL, last_seen_at TEXT
      )
    `));
    db.run(sql`
      INSERT INTO user (id, email, name, login, org_id, created, updated)
      VALUES ('u1', 'a@b.c', 'Alice', 'alice', 'org_main', 'now', 'now')
    `);

    applySchema(db);

    const tables = new Set(
      db
        .all<{ name: string }>(sql`SELECT name FROM sqlite_master WHERE type='table'`)
        .map((r) => r.name),
    );
    expect(tables.has('users')).toBe(true);
    expect(tables.has('user')).toBe(false);
    const rows = db.all<{ id: string }>(sql`SELECT id FROM users`);
    expect(rows.map((r) => r.id)).toEqual(['u1']);
  });

  it('migrates legacy connector_team_policies into connector_policies', () => {
    const db = createSqliteClient({ path: ':memory:', wal: false });
    // Bootstrap just enough schema to host the legacy table + its FK target.
    db.run(sql.raw(`
      CREATE TABLE org (
        id TEXT PRIMARY KEY, version INTEGER NOT NULL DEFAULT 0,
        name TEXT NOT NULL, created TEXT NOT NULL, updated TEXT NOT NULL
      )
    `));
    db.run(sql`INSERT INTO org (id, name, created, updated) VALUES ('org_main', 'Main', 'now', 'now')`);
    db.run(sql`INSERT INTO org (id, name, created, updated) VALUES ('org_other', 'Other', 'now', 'now')`);
    db.run(sql.raw(`
      CREATE TABLE connectors (
        id TEXT PRIMARY KEY,
        org_id TEXT NOT NULL,
        type TEXT NOT NULL,
        name TEXT NOT NULL,
        config TEXT NOT NULL,
        status TEXT NOT NULL,
        last_verified_at TEXT NULL,
        last_verify_error TEXT NULL,
        is_default INTEGER NOT NULL DEFAULT 0,
        created_by TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `));
    db.run(sql`
      INSERT INTO connectors (id, org_id, type, name, config, status, is_default, created_by, created_at, updated_at)
      VALUES ('c1', 'org_main', 'kubernetes', 'k1', '{}', 'active', 0, 'u', 'now', 'now')
    `);
    db.run(sql`
      INSERT INTO connectors (id, org_id, type, name, config, status, is_default, created_by, created_at, updated_at)
      VALUES ('c2', 'org_other', 'kubernetes', 'k2', '{}', 'active', 0, 'u', 'now', 'now')
    `);
    db.run(sql.raw(`
      CREATE TABLE connector_team_policies (
        connector_id TEXT NOT NULL,
        team_id TEXT NOT NULL DEFAULT '',
        capability TEXT NOT NULL,
        scope TEXT NULL,
        human_policy TEXT NOT NULL,
        agent_policy TEXT NOT NULL,
        PRIMARY KEY (connector_id, team_id, capability)
      )
    `));
    // Wildcard row → org-level, keyed by connector's org_id.
    db.run(sql`
      INSERT INTO connector_team_policies VALUES
      ('c1', '',       'runtime.get',    NULL, 'allow',           'allow'),
      ('c1', 'team-a', 'runtime.apply',  NULL, 'confirm',         'formal_approval'),
      ('c1', 'team-b', 'runtime.delete', NULL, 'strong_confirm',  'deny'),
      ('c2', '',       'runtime.get',    NULL, 'deny',            'deny')
    `);

    applySchema(db);

    const tables = new Set(
      db.all<{ name: string }>(sql`SELECT name FROM sqlite_master WHERE type='table'`).map((r) => r.name),
    );
    expect(tables.has('connector_team_policies')).toBe(false);
    expect(tables.has('connector_policies')).toBe(true);

    const rows = db.all<{
      connector_id: string;
      subject_type: string;
      subject_id: string;
      capability: string;
      human_policy: string;
    }>(sql`SELECT connector_id, subject_type, subject_id, capability, human_policy
           FROM connector_policies ORDER BY connector_id, subject_type, subject_id, capability`);

    expect(rows).toEqual([
      { connector_id: 'c1', subject_type: 'org',  subject_id: 'org_main', capability: 'runtime.get',    human_policy: 'allow' },
      { connector_id: 'c1', subject_type: 'team', subject_id: 'team-a',   capability: 'runtime.apply',  human_policy: 'ask' },
      { connector_id: 'c1', subject_type: 'team', subject_id: 'team-b',   capability: 'runtime.delete', human_policy: 'ask' },
      { connector_id: 'c2', subject_type: 'org',  subject_id: 'org_other', capability: 'runtime.get',   human_policy: 'block' },
    ]);

    // Idempotent: running applySchema again is a no-op (the old table is gone).
    applySchema(db);
    const count = db.all<{ n: number }>(sql`SELECT COUNT(*) AS n FROM connector_policies`)[0]!.n;
    expect(count).toBe(4);
  });

  it('is idempotent — second applySchema() is a no-op', () => {
    const db = createSqliteClient({ path: ':memory:', wal: false });
    applySchema(db);
    const firstCount = db.all<{ n: number }>(
      sql`SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table'`,
    )[0]!.n;
    applySchema(db);
    const secondCount = db.all<{ n: number }>(
      sql`SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table'`,
    )[0]!.n;
    expect(secondCount).toBe(firstCount);
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
