/**
 * team-sync unit tests (T5.2).
 *
 * Covers scenario 10 from docs/auth-perm-design/05-teams.md §test-scenarios:
 *   - user enters with groups [A, B] → team_members for A, B (external=1)
 *   - next login with [B, C] → A removed, B kept, C added
 *   - manually added team M → untouched
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  AuditLogRepository,
  DashboardAclRepository,
  PreferencesRepository,
  TeamMemberRepository,
  TeamRepository,
  UserRepository,
  createTestDb,
  seedDefaultOrg,
} from '@agentic-obs/data-layer';
import type { SqliteClient } from '@agentic-obs/data-layer';
import { AuditWriter } from './audit-writer.js';
import { TeamService } from '../services/team-service.js';
import { syncTeams, teamSyncEnabledFor } from './team-sync.js';

async function buildCtx(db: SqliteClient) {
  await seedDefaultOrg(db);
  const auditRepo = new AuditLogRepository(db);
  const teams = new TeamRepository(db);
  const teamMembers = new TeamMemberRepository(db);
  const preferences = new PreferencesRepository(db);
  const users = new UserRepository(db);
  const svc = new TeamService({
    teams,
    teamMembers,
    preferences,
    db,
    audit: new AuditWriter(auditRepo),
    dashboardAcl: new DashboardAclRepository(db),
  });
  return { teams, teamMembers, users, svc };
}

describe('syncTeams', () => {
  let db: SqliteClient;
  beforeEach(() => {
    db = createTestDb();
  });

  it('adds external memberships for each resolved group', async () => {
    const ctx = await buildCtx(db);
    const u = await ctx.users.create({
      email: 'u@x.y',
      name: 'U',
      login: 'u',
      orgId: 'org_main',
    });
    const a = await ctx.teams.create({
      orgId: 'org_main',
      name: 'GroupA',
      external: true,
    });
    const b = await ctx.teams.create({
      orgId: 'org_main',
      name: 'GroupB',
      external: true,
    });

    const result = await syncTeams(
      { teams: ctx.teams, teamMembers: ctx.teamMembers, teamService: ctx.svc },
      {
        userId: u.id,
        orgId: 'org_main',
        externalGroups: ['GroupA', 'GroupB'],
        authModule: 'oauth_generic',
      },
    );

    expect(result.added.sort()).toEqual([a.id, b.id].sort());
    expect(result.removed).toEqual([]);
    const rows = await ctx.teamMembers.listTeamsForUser(u.id, 'org_main');
    expect(rows.map((m) => m.teamId).sort()).toEqual([a.id, b.id].sort());
    for (const m of rows) expect(m.external).toBe(true);
  });

  it('delta sync: [A, B] then [B, C] yields removed A, added C, kept B', async () => {
    const ctx = await buildCtx(db);
    const u = await ctx.users.create({
      email: 'u2@x.y',
      name: 'U2',
      login: 'u2',
      orgId: 'org_main',
    });
    const a = await ctx.teams.create({
      orgId: 'org_main',
      name: 'A',
      external: true,
    });
    const b = await ctx.teams.create({
      orgId: 'org_main',
      name: 'B',
      external: true,
    });
    const c = await ctx.teams.create({
      orgId: 'org_main',
      name: 'C',
      external: true,
    });

    // First login.
    await syncTeams(
      { teams: ctx.teams, teamMembers: ctx.teamMembers, teamService: ctx.svc },
      {
        userId: u.id,
        orgId: 'org_main',
        externalGroups: ['A', 'B'],
        authModule: 'ldap',
      },
    );
    expect(
      (await ctx.teamMembers.listTeamsForUser(u.id, 'org_main'))
        .map((m) => m.teamId)
        .sort(),
    ).toEqual([a.id, b.id].sort());

    // Second login.
    const delta = await syncTeams(
      { teams: ctx.teams, teamMembers: ctx.teamMembers, teamService: ctx.svc },
      {
        userId: u.id,
        orgId: 'org_main',
        externalGroups: ['B', 'C'],
        authModule: 'ldap',
      },
    );
    expect(delta.added).toEqual([c.id]);
    expect(delta.removed).toEqual([a.id]);

    const rows = await ctx.teamMembers.listTeamsForUser(u.id, 'org_main');
    expect(rows.map((m) => m.teamId).sort()).toEqual([b.id, c.id].sort());
  });

  it('does not touch manually-added (external=0) memberships', async () => {
    const ctx = await buildCtx(db);
    const u = await ctx.users.create({
      email: 'u3@x.y',
      name: 'U3',
      login: 'u3',
      orgId: 'org_main',
    });
    // Manual team (external=false).
    const manual = await ctx.teams.create({
      orgId: 'org_main',
      name: 'Manual',
      external: false,
    });
    await ctx.svc.addMember('org_main', manual.id, u.id);

    // External team under sync.
    const extTeam = await ctx.teams.create({
      orgId: 'org_main',
      name: 'Ext',
      external: true,
    });

    await syncTeams(
      { teams: ctx.teams, teamMembers: ctx.teamMembers, teamService: ctx.svc },
      {
        userId: u.id,
        orgId: 'org_main',
        externalGroups: ['Ext'],
        authModule: 'saml',
      },
    );

    // Now drop Ext from the groups list. Manual should still be there.
    await syncTeams(
      { teams: ctx.teams, teamMembers: ctx.teamMembers, teamService: ctx.svc },
      {
        userId: u.id,
        orgId: 'org_main',
        externalGroups: [],
        authModule: 'saml',
      },
    );

    const rows = await ctx.teamMembers.listTeamsForUser(u.id, 'org_main');
    expect(rows.map((m) => m.teamId)).toEqual([manual.id]);
    expect(rows[0]?.external).toBe(false);
  });

  it('skips groups that do not resolve to an external team', async () => {
    const ctx = await buildCtx(db);
    const u = await ctx.users.create({
      email: 'u4@x.y',
      name: 'U4',
      login: 'u4',
      orgId: 'org_main',
    });
    // Non-external team with matching name — should NOT be auto-promoted.
    await ctx.teams.create({
      orgId: 'org_main',
      name: 'NotExternal',
      external: false,
    });

    const result = await syncTeams(
      { teams: ctx.teams, teamMembers: ctx.teamMembers, teamService: ctx.svc },
      {
        userId: u.id,
        orgId: 'org_main',
        externalGroups: ['NotExternal', 'Unknown'],
        authModule: 'oauth_github',
      },
    );
    expect(result.added).toEqual([]);
    expect(result.skipped.sort()).toEqual(['NotExternal', 'Unknown'].sort());
    const rows = await ctx.teamMembers.listTeamsForUser(u.id, 'org_main');
    expect(rows).toHaveLength(0);
  });

  it('returns empty diff when both inputs and current are empty', async () => {
    const ctx = await buildCtx(db);
    const u = await ctx.users.create({
      email: 'u5@x.y',
      name: 'U5',
      login: 'u5',
      orgId: 'org_main',
    });
    const result = await syncTeams(
      { teams: ctx.teams, teamMembers: ctx.teamMembers, teamService: ctx.svc },
      {
        userId: u.id,
        orgId: 'org_main',
        externalGroups: [],
        authModule: 'ldap',
      },
    );
    expect(result).toEqual({ added: [], removed: [], skipped: [] });
  });

  it('re-syncing with the same groups is a no-op', async () => {
    const ctx = await buildCtx(db);
    const u = await ctx.users.create({
      email: 'u6@x.y',
      name: 'U6',
      login: 'u6',
      orgId: 'org_main',
    });
    const a = await ctx.teams.create({
      orgId: 'org_main',
      name: 'StableA',
      external: true,
    });
    await syncTeams(
      { teams: ctx.teams, teamMembers: ctx.teamMembers, teamService: ctx.svc },
      {
        userId: u.id,
        orgId: 'org_main',
        externalGroups: ['StableA'],
        authModule: 'ldap',
      },
    );
    const second = await syncTeams(
      { teams: ctx.teams, teamMembers: ctx.teamMembers, teamService: ctx.svc },
      {
        userId: u.id,
        orgId: 'org_main',
        externalGroups: ['StableA'],
        authModule: 'ldap',
      },
    );
    expect(second.added).toEqual([]);
    expect(second.removed).toEqual([]);
    const rows = await ctx.teamMembers.listTeamsForUser(u.id, 'org_main');
    expect(rows.map((m) => m.teamId)).toEqual([a.id]);
  });

  it('no-ops cleanly when userId or orgId is missing', async () => {
    const ctx = await buildCtx(db);
    const result = await syncTeams(
      { teams: ctx.teams, teamMembers: ctx.teamMembers, teamService: ctx.svc },
      {
        userId: '',
        orgId: '',
        externalGroups: ['x'],
        authModule: 'ldap',
      },
    );
    expect(result).toEqual({ added: [], removed: [], skipped: [] });
  });

  it('whitespace-only group names are skipped', async () => {
    const ctx = await buildCtx(db);
    const u = await ctx.users.create({
      email: 'ws@x.y',
      name: 'WS',
      login: 'ws',
      orgId: 'org_main',
    });
    const result = await syncTeams(
      { teams: ctx.teams, teamMembers: ctx.teamMembers, teamService: ctx.svc },
      {
        userId: u.id,
        orgId: 'org_main',
        externalGroups: ['', '   '],
        authModule: 'saml',
      },
    );
    expect(result).toEqual({ added: [], removed: [], skipped: [] });
  });
});

describe('teamSyncEnabledFor', () => {
  it('reads the per-provider env flag', () => {
    expect(teamSyncEnabledFor('ldap', { LDAP_SYNC_TEAMS: 'true' })).toBe(true);
    expect(teamSyncEnabledFor('ldap', { LDAP_SYNC_TEAMS: 'false' })).toBe(false);
    expect(teamSyncEnabledFor('ldap', {})).toBe(false);

    expect(
      teamSyncEnabledFor('oauth_github', { OAUTH_GITHUB_SYNC_TEAMS: 'true' }),
    ).toBe(true);
    expect(
      teamSyncEnabledFor('oauth_google', { OAUTH_GOOGLE_SYNC_TEAMS: 'true' }),
    ).toBe(true);
    expect(
      teamSyncEnabledFor('oauth_generic', { OAUTH_GENERIC_SYNC_TEAMS: 'true' }),
    ).toBe(true);
    expect(teamSyncEnabledFor('saml', { SAML_SYNC_TEAMS: 'true' })).toBe(true);
  });

  it('returns false for unknown auth modules (type system guard)', () => {
    // Cast to silence the compile-time check — we want to verify runtime safety.
    expect(
      teamSyncEnabledFor(
        'bogus' as unknown as 'ldap',
        { LDAP_SYNC_TEAMS: 'true' },
      ),
    ).toBe(false);
  });
});
