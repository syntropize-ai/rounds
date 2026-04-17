import { sql } from 'drizzle-orm';
import type { SqliteClient } from '../../db/sqlite-client.js';
import type { IUserAuthTokenRepository } from '@agentic-obs/common';
import type { UserAuthToken, NewUserAuthToken } from '@agentic-obs/common';
import { uid, nowIso, toBool, fromBool } from './shared.js';

interface Row {
  id: string;
  user_id: string;
  auth_token: string;
  prev_auth_token: string;
  user_agent: string;
  client_ip: string;
  auth_token_seen: number;
  seen_at: string | null;
  rotated_at: string;
  created_at: string;
  updated_at: string;
  revoked_at: string | null;
}

function rowTo(r: Row): UserAuthToken {
  return {
    id: r.id,
    userId: r.user_id,
    authToken: r.auth_token,
    prevAuthToken: r.prev_auth_token,
    userAgent: r.user_agent,
    clientIp: r.client_ip,
    authTokenSeen: toBool(r.auth_token_seen),
    seenAt: r.seen_at,
    rotatedAt: r.rotated_at,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    revokedAt: r.revoked_at,
  };
}

export class UserAuthTokenRepository implements IUserAuthTokenRepository {
  constructor(private readonly db: SqliteClient) {}

  async create(input: NewUserAuthToken): Promise<UserAuthToken> {
    const id = input.id ?? uid();
    const now = nowIso();
    this.db.run(sql`
      INSERT INTO user_auth_token (
        id, user_id, auth_token, prev_auth_token, user_agent, client_ip,
        auth_token_seen, seen_at, rotated_at, created_at, updated_at, revoked_at
      ) VALUES (
        ${id}, ${input.userId}, ${input.authToken}, ${input.prevAuthToken ?? ''},
        ${input.userAgent}, ${input.clientIp},
        ${fromBool(input.authTokenSeen)}, ${input.seenAt ?? null},
        ${input.rotatedAt ?? now}, ${now}, ${now}, NULL
      )
    `);
    const row = await this.findById(id);
    if (!row) throw new Error(`[UserAuthTokenRepository] create failed for id=${id}`);
    return row;
  }

  async findById(id: string): Promise<UserAuthToken | null> {
    const rows = this.db.all<Row>(sql`SELECT * FROM user_auth_token WHERE id = ${id}`);
    return rows[0] ? rowTo(rows[0]) : null;
  }

  async findByHashedToken(hashedToken: string): Promise<UserAuthToken | null> {
    // Live lookup — current and the single-rotation grace window both count,
    // revoked tokens don't.
    const rows = this.db.all<Row>(sql`
      SELECT * FROM user_auth_token
      WHERE revoked_at IS NULL
        AND (auth_token = ${hashedToken} OR prev_auth_token = ${hashedToken})
      LIMIT 1
    `);
    return rows[0] ? rowTo(rows[0]) : null;
  }

  async listByUser(userId: string, includeRevoked = false): Promise<UserAuthToken[]> {
    const rows = includeRevoked
      ? this.db.all<Row>(
          sql`SELECT * FROM user_auth_token WHERE user_id = ${userId} ORDER BY created_at DESC`,
        )
      : this.db.all<Row>(sql`
          SELECT * FROM user_auth_token
          WHERE user_id = ${userId} AND revoked_at IS NULL
          ORDER BY created_at DESC
        `);
    return rows.map(rowTo);
  }

  async rotate(id: string, newHashedToken: string, rotatedAt: string): Promise<UserAuthToken | null> {
    const existing = await this.findById(id);
    if (!existing || existing.revokedAt !== null) return null;
    const now = nowIso();
    this.db.run(sql`
      UPDATE user_auth_token SET
        prev_auth_token = auth_token,
        auth_token = ${newHashedToken},
        rotated_at = ${rotatedAt},
        updated_at = ${now}
      WHERE id = ${id}
    `);
    return this.findById(id);
  }

  async markSeen(id: string, seenAt: string): Promise<void> {
    const now = nowIso();
    this.db.run(sql`
      UPDATE user_auth_token SET
        auth_token_seen = 1,
        seen_at = ${seenAt},
        updated_at = ${now}
      WHERE id = ${id}
    `);
  }

  async revoke(id: string, revokedAt: string): Promise<void> {
    const now = nowIso();
    this.db.run(sql`
      UPDATE user_auth_token SET revoked_at = ${revokedAt}, updated_at = ${now}
      WHERE id = ${id}
    `);
  }

  async revokeAllForUser(userId: string, revokedAt: string): Promise<number> {
    const now = nowIso();
    const before = this.db.all<{ n: number }>(sql`
      SELECT COUNT(*) AS n FROM user_auth_token
      WHERE user_id = ${userId} AND revoked_at IS NULL
    `);
    this.db.run(sql`
      UPDATE user_auth_token SET revoked_at = ${revokedAt}, updated_at = ${now}
      WHERE user_id = ${userId} AND revoked_at IS NULL
    `);
    return before[0]?.n ?? 0;
  }

  async deleteExpired(before: string): Promise<number> {
    const cntRows = this.db.all<{ n: number }>(sql`
      SELECT COUNT(*) AS n FROM user_auth_token WHERE created_at < ${before}
    `);
    const n = cntRows[0]?.n ?? 0;
    this.db.run(sql`DELETE FROM user_auth_token WHERE created_at < ${before}`);
    return n;
  }
}
