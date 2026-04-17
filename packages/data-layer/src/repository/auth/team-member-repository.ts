import { sql } from 'drizzle-orm';
import type { SqliteClient } from '../../db/sqlite-client.js';
import type { ITeamMemberRepository } from '@agentic-obs/common';
import type { TeamMember, NewTeamMember, TeamMemberPermission } from '@agentic-obs/common';
import { TEAM_MEMBER_PERMISSION_MEMBER } from '@agentic-obs/common';
import { uid, nowIso, toBool, fromBool } from './shared.js';

interface Row {
  id: string;
  org_id: string;
  team_id: string;
  user_id: string;
  external: number;
  permission: number;
  created: string;
  updated: string;
}

function rowTo(r: Row): TeamMember {
  return {
    id: r.id,
    orgId: r.org_id,
    teamId: r.team_id,
    userId: r.user_id,
    external: toBool(r.external),
    permission: r.permission as TeamMemberPermission,
    created: r.created,
    updated: r.updated,
  };
}

export class TeamMemberRepository implements ITeamMemberRepository {
  constructor(private readonly db: SqliteClient) {}

  async create(input: NewTeamMember): Promise<TeamMember> {
    const id = input.id ?? uid();
    const now = nowIso();
    this.db.run(sql`
      INSERT INTO team_member (
        id, org_id, team_id, user_id, external, permission, created, updated
      ) VALUES (
        ${id}, ${input.orgId}, ${input.teamId}, ${input.userId},
        ${fromBool(input.external)}, ${input.permission ?? TEAM_MEMBER_PERMISSION_MEMBER},
        ${now}, ${now}
      )
    `);
    const row = await this.findById(id);
    if (!row) throw new Error(`[TeamMemberRepository] create failed for id=${id}`);
    return row;
  }

  async findById(id: string): Promise<TeamMember | null> {
    const rows = this.db.all<Row>(sql`SELECT * FROM team_member WHERE id = ${id}`);
    return rows[0] ? rowTo(rows[0]) : null;
  }

  async findMembership(teamId: string, userId: string): Promise<TeamMember | null> {
    const rows = this.db.all<Row>(sql`
      SELECT * FROM team_member WHERE team_id = ${teamId} AND user_id = ${userId}
    `);
    return rows[0] ? rowTo(rows[0]) : null;
  }

  async listByTeam(teamId: string): Promise<TeamMember[]> {
    const rows = this.db.all<Row>(
      sql`SELECT * FROM team_member WHERE team_id = ${teamId} ORDER BY created`,
    );
    return rows.map(rowTo);
  }

  async listTeamsForUser(userId: string, orgId?: string): Promise<TeamMember[]> {
    const rows = orgId
      ? this.db.all<Row>(sql`
          SELECT * FROM team_member WHERE user_id = ${userId} AND org_id = ${orgId}
        `)
      : this.db.all<Row>(sql`SELECT * FROM team_member WHERE user_id = ${userId}`);
    return rows.map(rowTo);
  }

  async updatePermission(
    teamId: string,
    userId: string,
    permission: TeamMemberPermission,
  ): Promise<TeamMember | null> {
    const existing = await this.findMembership(teamId, userId);
    if (!existing) return null;
    const now = nowIso();
    this.db.run(sql`
      UPDATE team_member SET permission = ${permission}, updated = ${now}
      WHERE team_id = ${teamId} AND user_id = ${userId}
    `);
    return this.findMembership(teamId, userId);
  }

  async remove(teamId: string, userId: string): Promise<boolean> {
    const existing = await this.findMembership(teamId, userId);
    if (!existing) return false;
    this.db.run(
      sql`DELETE FROM team_member WHERE team_id = ${teamId} AND user_id = ${userId}`,
    );
    return true;
  }

  async removeAllByUser(userId: string): Promise<number> {
    const before = this.db.all<{ n: number }>(
      sql`SELECT COUNT(*) AS n FROM team_member WHERE user_id = ${userId}`,
    );
    this.db.run(sql`DELETE FROM team_member WHERE user_id = ${userId}`);
    return before[0]?.n ?? 0;
  }
}
