import { describe, it, expect } from 'vitest';
import { sql } from 'drizzle-orm';
import { createSqliteClient, type SqliteClient } from './sqlite-client.js';
import { applySchema, splitSqlStatements } from './schema-applier.js';
import { SqliteConnectorRepository } from '../repository/sqlite/connector.js';

/** Read a connector_secrets row without the repository's decryption. */
function readSecret(
  db: SqliteClient,
  connectorId: string,
): { ciphertext: Uint8Array; key_version: number } {
  return db.all<{ ciphertext: Uint8Array; key_version: number }>(
    sql`SELECT ciphertext, key_version FROM connector_secrets WHERE connector_id = ${connectorId}`,
  )[0]!;
}

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

  it('drops the legacy connector_team_policies table without copying data', () => {
    const db = createSqliteClient({ path: ':memory:', wal: false });
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
    db.run(sql`
      INSERT INTO connector_team_policies VALUES
      ('c1', '',       'runtime.get',   NULL, 'allow',   'allow'),
      ('c1', 'team-a', 'runtime.apply', NULL, 'confirm', 'formal_approval')
    `);

    applySchema(db);

    const tables = new Set(
      db.all<{ name: string }>(sql`SELECT name FROM sqlite_master WHERE type='table'`).map((r) => r.name),
    );
    expect(tables.has('connector_team_policies')).toBe(false);
    expect(tables.has('connector_policies')).toBe(true);

    const count = db.all<{ n: number }>(sql`SELECT COUNT(*) AS n FROM connector_policies`)[0]!.n;
    expect(count).toBe(0);

    // Idempotent.
    applySchema(db);
    expect(db.all<{ n: number }>(sql`SELECT COUNT(*) AS n FROM connector_policies`)[0]!.n).toBe(0);
  });

  it('encrypts pre-existing plaintext connector secrets, idempotently', async () => {
    const prevSecret = process.env['SECRET_KEY'];
    process.env['SECRET_KEY'] =
      prevSecret ?? 'test-secret-key-for-connector-secret-migration-xx';
    try {
      const db = createSqliteClient({ path: ':memory:', wal: false });
      applySchema(db);
      db.run(sql`
        INSERT INTO connectors (
          id, org_id, type, name, config, status, is_default, created_by, created_at, updated_at
        ) VALUES ('c1', 'org_main', 'kubernetes', 'prod', '{}', 'active', 0, 'u1', 'now', 'now')
      `);
      // A row exactly as the pre-encryption code wrote it: raw bytes at key_version 1.
      const plaintext = 'kubeconfig-with-sup3r-s3cret-token';
      db.run(sql`
        INSERT INTO connector_secrets (connector_id, ciphertext, key_version, created_at, updated_at)
        VALUES ('c1', ${Buffer.from(plaintext, 'utf8')}, 1, 'now', 'now')
      `);

      applySchema(db);

      const migrated = readSecret(db, 'c1');
      expect(migrated.key_version).toBe(2);
      expect(Buffer.from(migrated.ciphertext).toString('utf8')).not.toContain('sup3r-s3cret-token');
      // The migrated envelope still decrypts to the original credential.
      const viaRepo = await new SqliteConnectorRepository(db).getSecret('c1');
      expect(Buffer.from(viaRepo!.ciphertext).toString('utf8')).toBe(plaintext);

      // Second boot must not double-encrypt.
      applySchema(db);
      const after = readSecret(db, 'c1');
      expect(Buffer.from(after.ciphertext).toString('utf8')).toBe(
        Buffer.from(migrated.ciphertext).toString('utf8'),
      );
      expect(after.key_version).toBe(2);
    } finally {
      if (prevSecret === undefined) delete process.env['SECRET_KEY'];
      else process.env['SECRET_KEY'] = prevSecret;
    }
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
