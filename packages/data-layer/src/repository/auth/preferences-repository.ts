import { sql } from 'drizzle-orm';
import type { SqliteClient } from '../../db/sqlite-client.js';
import type { IPreferencesRepository } from '@agentic-obs/common';
import type { Preferences, NewPreferences, PreferencesPatch } from '@agentic-obs/common';
import { uid, nowIso } from './shared.js';

interface Row {
  id: string;
  org_id: string;
  user_id: string | null;
  team_id: string | null;
  version: number;
  home_dashboard_uid: string | null;
  timezone: string | null;
  week_start: string | null;
  theme: string | null;
  locale: string | null;
  json_data: string | null;
  created: string;
  updated: string;
}

function rowTo(r: Row): Preferences {
  return {
    id: r.id,
    orgId: r.org_id,
    userId: r.user_id,
    teamId: r.team_id,
    version: r.version,
    homeDashboardUid: r.home_dashboard_uid,
    timezone: r.timezone,
    weekStart: r.week_start,
    theme: r.theme,
    locale: r.locale,
    jsonData: r.json_data,
    created: r.created,
    updated: r.updated,
  };
}

function findKeyQuery(orgId: string, userId: string | null, teamId: string | null) {
  const uidCoalesce = userId ?? '';
  const tidCoalesce = teamId ?? '';
  return sql`
    SELECT * FROM preferences
    WHERE org_id = ${orgId}
      AND COALESCE(user_id, '') = ${uidCoalesce}
      AND COALESCE(team_id, '') = ${tidCoalesce}
    LIMIT 1
  `;
}

export class PreferencesRepository implements IPreferencesRepository {
  constructor(private readonly db: SqliteClient) {}

  async upsert(input: NewPreferences): Promise<Preferences> {
    const now = nowIso();
    const userId = input.userId ?? null;
    const teamId = input.teamId ?? null;

    const existingRows = this.db.all<Row>(findKeyQuery(input.orgId, userId, teamId));
    const existing = existingRows[0];

    if (existing) {
      this.db.run(sql`
        UPDATE preferences SET
          version = version + 1,
          home_dashboard_uid = ${input.homeDashboardUid ?? existing.home_dashboard_uid},
          timezone = ${input.timezone ?? existing.timezone},
          week_start = ${input.weekStart ?? existing.week_start},
          theme = ${input.theme ?? existing.theme},
          locale = ${input.locale ?? existing.locale},
          json_data = ${input.jsonData ?? existing.json_data},
          updated = ${now}
        WHERE id = ${existing.id}
      `);
      const updated = this.db.all<Row>(sql`SELECT * FROM preferences WHERE id = ${existing.id}`);
      return rowTo(updated[0]!);
    }

    const id = input.id ?? uid();
    this.db.run(sql`
      INSERT INTO preferences (
        id, org_id, user_id, team_id, version,
        home_dashboard_uid, timezone, week_start, theme, locale, json_data,
        created, updated
      ) VALUES (
        ${id}, ${input.orgId}, ${userId}, ${teamId}, 0,
        ${input.homeDashboardUid ?? null}, ${input.timezone ?? null},
        ${input.weekStart ?? null}, ${input.theme ?? null},
        ${input.locale ?? null}, ${input.jsonData ?? null},
        ${now}, ${now}
      )
    `);
    const rows = this.db.all<Row>(sql`SELECT * FROM preferences WHERE id = ${id}`);
    if (!rows[0]) throw new Error(`[PreferencesRepository] upsert failed for id=${id}`);
    return rowTo(rows[0]);
  }

  async findOrgPrefs(orgId: string): Promise<Preferences | null> {
    const rows = this.db.all<Row>(findKeyQuery(orgId, null, null));
    return rows[0] ? rowTo(rows[0]) : null;
  }

  async findUserPrefs(orgId: string, userId: string): Promise<Preferences | null> {
    const rows = this.db.all<Row>(findKeyQuery(orgId, userId, null));
    return rows[0] ? rowTo(rows[0]) : null;
  }

  async findTeamPrefs(orgId: string, teamId: string): Promise<Preferences | null> {
    const rows = this.db.all<Row>(findKeyQuery(orgId, null, teamId));
    return rows[0] ? rowTo(rows[0]) : null;
  }

  async update(id: string, patch: PreferencesPatch): Promise<Preferences | null> {
    const existingRows = this.db.all<Row>(sql`SELECT * FROM preferences WHERE id = ${id}`);
    const existing = existingRows[0];
    if (!existing) return null;
    const now = nowIso();
    this.db.run(sql`
      UPDATE preferences SET
        version = version + 1,
        home_dashboard_uid = ${patch.homeDashboardUid !== undefined ? patch.homeDashboardUid : existing.home_dashboard_uid},
        timezone = ${patch.timezone !== undefined ? patch.timezone : existing.timezone},
        week_start = ${patch.weekStart !== undefined ? patch.weekStart : existing.week_start},
        theme = ${patch.theme !== undefined ? patch.theme : existing.theme},
        locale = ${patch.locale !== undefined ? patch.locale : existing.locale},
        json_data = ${patch.jsonData !== undefined ? patch.jsonData : existing.json_data},
        updated = ${now}
      WHERE id = ${id}
    `);
    const rows = this.db.all<Row>(sql`SELECT * FROM preferences WHERE id = ${id}`);
    return rows[0] ? rowTo(rows[0]) : null;
  }

  async delete(id: string): Promise<boolean> {
    const before = this.db.all<Row>(sql`SELECT id FROM preferences WHERE id = ${id}`);
    if (before.length === 0) return false;
    this.db.run(sql`DELETE FROM preferences WHERE id = ${id}`);
    return true;
  }
}
