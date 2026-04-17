import { sql } from 'drizzle-orm';
import type { SqliteClient } from '../../db/sqlite-client.js';
import type { IUserAuthRepository } from '@agentic-obs/common';
import type { UserAuth, NewUserAuth } from '@agentic-obs/common';
import { uid, nowIso } from './shared.js';

interface UserAuthRow {
  id: string;
  user_id: string;
  auth_module: string;
  auth_id: string;
  created: string;
  o_auth_access_token: string | null;
  o_auth_refresh_token: string | null;
  o_auth_token_type: string | null;
  o_auth_expiry: number | null;
  o_auth_id_token: string | null;
}

function rowTo(r: UserAuthRow): UserAuth {
  return {
    id: r.id,
    userId: r.user_id,
    authModule: r.auth_module,
    authId: r.auth_id,
    created: r.created,
    oAuthAccessToken: r.o_auth_access_token,
    oAuthRefreshToken: r.o_auth_refresh_token,
    oAuthTokenType: r.o_auth_token_type,
    oAuthExpiry: r.o_auth_expiry,
    oAuthIdToken: r.o_auth_id_token,
  };
}

export class UserAuthRepository implements IUserAuthRepository {
  constructor(private readonly db: SqliteClient) {}

  async create(input: NewUserAuth): Promise<UserAuth> {
    const id = input.id ?? uid();
    const now = nowIso();
    this.db.run(sql`
      INSERT INTO user_auth (
        id, user_id, auth_module, auth_id, created,
        o_auth_access_token, o_auth_refresh_token, o_auth_token_type,
        o_auth_expiry, o_auth_id_token
      ) VALUES (
        ${id}, ${input.userId}, ${input.authModule}, ${input.authId}, ${now},
        ${input.oAuthAccessToken ?? null}, ${input.oAuthRefreshToken ?? null},
        ${input.oAuthTokenType ?? null}, ${input.oAuthExpiry ?? null},
        ${input.oAuthIdToken ?? null}
      )
    `);
    const row = await this.findById(id);
    if (!row) throw new Error(`[UserAuthRepository] create failed for id=${id}`);
    return row;
  }

  async findById(id: string): Promise<UserAuth | null> {
    const rows = this.db.all<UserAuthRow>(sql`SELECT * FROM user_auth WHERE id = ${id}`);
    return rows[0] ? rowTo(rows[0]) : null;
  }

  async findByAuthInfo(authModule: string, authId: string): Promise<UserAuth | null> {
    const rows = this.db.all<UserAuthRow>(sql`
      SELECT * FROM user_auth
      WHERE auth_module = ${authModule} AND auth_id = ${authId}
      LIMIT 1
    `);
    return rows[0] ? rowTo(rows[0]) : null;
  }

  async listByUser(userId: string): Promise<UserAuth[]> {
    const rows = this.db.all<UserAuthRow>(
      sql`SELECT * FROM user_auth WHERE user_id = ${userId} ORDER BY created`,
    );
    return rows.map(rowTo);
  }

  async update(
    id: string,
    patch: Partial<Omit<UserAuth, 'id' | 'userId' | 'created'>>,
  ): Promise<UserAuth | null> {
    const existing = await this.findById(id);
    if (!existing) return null;
    const m = {
      authModule: patch.authModule ?? existing.authModule,
      authId: patch.authId ?? existing.authId,
      oAuthAccessToken:
        patch.oAuthAccessToken !== undefined ? patch.oAuthAccessToken : existing.oAuthAccessToken,
      oAuthRefreshToken:
        patch.oAuthRefreshToken !== undefined ? patch.oAuthRefreshToken : existing.oAuthRefreshToken,
      oAuthTokenType:
        patch.oAuthTokenType !== undefined ? patch.oAuthTokenType : existing.oAuthTokenType,
      oAuthExpiry: patch.oAuthExpiry !== undefined ? patch.oAuthExpiry : existing.oAuthExpiry,
      oAuthIdToken:
        patch.oAuthIdToken !== undefined ? patch.oAuthIdToken : existing.oAuthIdToken,
    };
    this.db.run(sql`
      UPDATE user_auth SET
        auth_module = ${m.authModule},
        auth_id = ${m.authId},
        o_auth_access_token = ${m.oAuthAccessToken},
        o_auth_refresh_token = ${m.oAuthRefreshToken},
        o_auth_token_type = ${m.oAuthTokenType},
        o_auth_expiry = ${m.oAuthExpiry},
        o_auth_id_token = ${m.oAuthIdToken}
      WHERE id = ${id}
    `);
    return this.findById(id);
  }

  async delete(id: string): Promise<boolean> {
    const before = await this.findById(id);
    if (!before) return false;
    this.db.run(sql`DELETE FROM user_auth WHERE id = ${id}`);
    return true;
  }

  async deleteByUser(userId: string): Promise<number> {
    const before = this.db.all<{ n: number }>(
      sql`SELECT COUNT(*) AS n FROM user_auth WHERE user_id = ${userId}`,
    );
    const n = before[0]?.n ?? 0;
    this.db.run(sql`DELETE FROM user_auth WHERE user_id = ${userId}`);
    return n;
  }
}
