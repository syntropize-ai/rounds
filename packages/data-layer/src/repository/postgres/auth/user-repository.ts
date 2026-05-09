import { sql, type SQL } from 'drizzle-orm';
import type { DbClient } from '../../../db/client.js';
import { pgAll, pgRun } from '../pg-helpers.js';
import type {
  IUserRepository,
  ListUsersOptions,
  Page,
} from '@agentic-obs/common';
import type { User, NewUser, UserPatch } from '@agentic-obs/common';
import { uid, nowIso, toBool, fromBool } from './shared.js';

interface UserRow {
  id: string;
  version: number;
  email: string;
  name: string;
  login: string;
  password: string | null;
  salt: string | null;
  rands: string | null;
  company: string | null;
  org_id: string;
  is_admin: number;
  email_verified: number;
  theme: string | null;
  help_flags1: number;
  is_disabled: number;
  is_service_account: number;
  created: string;
  updated: string;
  last_seen_at: string | null;
}

function rowToUser(r: UserRow): User {
  return {
    id: r.id,
    version: r.version,
    email: r.email,
    name: r.name,
    login: r.login,
    password: r.password,
    salt: r.salt,
    rands: r.rands,
    company: r.company,
    orgId: r.org_id,
    isAdmin: toBool(r.is_admin),
    emailVerified: toBool(r.email_verified),
    theme: r.theme,
    helpFlags1: r.help_flags1,
    isDisabled: toBool(r.is_disabled),
    isServiceAccount: toBool(r.is_service_account),
    created: r.created,
    updated: r.updated,
    lastSeenAt: r.last_seen_at,
  };
}

export class UserRepository implements IUserRepository {
  constructor(private readonly db: DbClient) {}

  async create(input: NewUser): Promise<User> {
    const id = input.id ?? uid();
    const now = nowIso();
    await pgRun(this.db, sql`
      INSERT INTO users (
        id, version, email, name, login, password, salt, rands, company,
        org_id, is_admin, email_verified, theme, help_flags1, is_disabled,
        is_service_account, created, updated, last_seen_at
      ) VALUES (
        ${id}, 0,
        ${input.email}, ${input.name}, ${input.login},
        ${input.password ?? null}, ${input.salt ?? null}, ${input.rands ?? null},
        ${input.company ?? null},
        ${input.orgId},
        ${fromBool(input.isAdmin)},
        ${fromBool(input.emailVerified)},
        ${input.theme ?? null},
        ${input.helpFlags1 ?? 0},
        ${fromBool(input.isDisabled)},
        ${fromBool(input.isServiceAccount)},
        ${now}, ${now}, NULL
      )
    `);
    const row = await this.findById(id);
    if (!row) throw new Error(`[UserRepository] create: inserted row not found for id=${id}`);
    return row;
  }

  async findById(id: string): Promise<User | null> {
    const rows = await pgAll<UserRow>(this.db, sql`SELECT * FROM users WHERE id = ${id}`);
    return rows[0] ? rowToUser(rows[0]) : null;
  }

  async findByLogin(login: string): Promise<User | null> {
    const rows = await pgAll<UserRow>(this.db, sql`SELECT * FROM users WHERE login = ${login}`);
    return rows[0] ? rowToUser(rows[0]) : null;
  }

  async findByEmail(email: string): Promise<User | null> {
    const rows = await pgAll<UserRow>(this.db, sql`SELECT * FROM users WHERE email = ${email}`);
    return rows[0] ? rowToUser(rows[0]) : null;
  }

  async findByAuthInfo(authModule: string, authId: string): Promise<User | null> {
    const rows = await pgAll<UserRow>(this.db, sql`
      SELECT u.* FROM users u
      INNER JOIN user_auth ua ON ua.user_id = u.id
      WHERE ua.auth_module = ${authModule} AND ua.auth_id = ${authId}
      LIMIT 1
    `);
    return rows[0] ? rowToUser(rows[0]) : null;
  }

  async list(opts: ListUsersOptions = {}): Promise<Page<User>> {
    const limit = opts.limit ?? 100;
    const offset = opts.offset ?? 0;
    const wheres: SQL[] = [];
    if (opts.orgId !== undefined) wheres.push(sql`org_id = ${opts.orgId}`);
    if (opts.isServiceAccount !== undefined)
      wheres.push(sql`is_service_account = ${fromBool(opts.isServiceAccount)}`);
    if (opts.isDisabled !== undefined)
      wheres.push(sql`is_disabled = ${fromBool(opts.isDisabled)}`);
    if (opts.search) {
      const pat = `%${opts.search}%`;
      wheres.push(sql`(login LIKE ${pat} OR email LIKE ${pat} OR name LIKE ${pat})`);
    }
    const whereClause = wheres.length
      ? sql.join([sql`WHERE`, sql.join(wheres, sql` AND `)], sql` `)
      : sql``;

    const rows = await pgAll<UserRow>(this.db, sql`
      SELECT * FROM users ${whereClause}
      ORDER BY login
      LIMIT ${limit} OFFSET ${offset}
    `);
    const totalRows = await pgAll<{ n: number }>(this.db, sql`
      SELECT COUNT(*) AS n FROM users ${whereClause}
    `);
    return { items: rows.map(rowToUser), total: totalRows[0]?.n ?? 0 };
  }

  async update(id: string, patch: UserPatch): Promise<User | null> {
    const existing = await this.findById(id);
    if (!existing) return null;
    const now = nowIso();
    const m = {
      email: patch.email ?? existing.email,
      name: patch.name ?? existing.name,
      login: patch.login ?? existing.login,
      password: patch.password !== undefined ? patch.password : existing.password,
      salt: patch.salt !== undefined ? patch.salt : existing.salt,
      rands: patch.rands !== undefined ? patch.rands : existing.rands,
      company: patch.company !== undefined ? patch.company : existing.company,
      orgId: patch.orgId ?? existing.orgId,
      isAdmin: patch.isAdmin ?? existing.isAdmin,
      emailVerified: patch.emailVerified ?? existing.emailVerified,
      theme: patch.theme !== undefined ? patch.theme : existing.theme,
      helpFlags1: patch.helpFlags1 ?? existing.helpFlags1,
      isDisabled: patch.isDisabled ?? existing.isDisabled,
      isServiceAccount: patch.isServiceAccount ?? existing.isServiceAccount,
    };
    await pgRun(this.db, sql`
      UPDATE users SET
        version = version + 1,
        email = ${m.email},
        name = ${m.name},
        login = ${m.login},
        password = ${m.password},
        salt = ${m.salt},
        rands = ${m.rands},
        company = ${m.company},
        org_id = ${m.orgId},
        is_admin = ${fromBool(m.isAdmin)},
        email_verified = ${fromBool(m.emailVerified)},
        theme = ${m.theme},
        help_flags1 = ${m.helpFlags1},
        is_disabled = ${fromBool(m.isDisabled)},
        is_service_account = ${fromBool(m.isServiceAccount)},
        updated = ${now}
      WHERE id = ${id}
    `);
    return this.findById(id);
  }

  async delete(id: string): Promise<boolean> {
    const before = await this.findById(id);
    if (!before) return false;
    await pgRun(this.db, sql`DELETE FROM users WHERE id = ${id}`);
    return true;
  }

  async setDisabled(id: string, disabled: boolean): Promise<void> {
    const now = nowIso();
    await pgRun(this.db, sql`
      UPDATE users SET is_disabled = ${fromBool(disabled)}, updated = ${now}
      WHERE id = ${id}
    `);
  }

  async updateLastSeen(id: string, at: string): Promise<void> {
    await pgRun(this.db, sql`UPDATE users SET last_seen_at = ${at} WHERE id = ${id}`);
  }

  async countServiceAccounts(orgId: string): Promise<number> {
    const rows = await pgAll<{ n: number }>(this.db, sql`
      SELECT COUNT(*) AS n FROM users
      WHERE org_id = ${orgId} AND is_service_account = ${fromBool(true)}
    `);
    return rows[0]?.n ?? 0;
  }
}
