/**
 * TeamService unit tests.
 *
 * Covers scenarios from docs/auth-perm-design/05-teams.md §test-scenarios
 * 1-6 and 9-13 (scenarios 7, 8, 10 test team-role permission propagation and
 * external sync — covered by accesscontrol-service.test.ts and team-sync.test.ts
 * respectively).
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  AuditLogRepository,
  DashboardAclRepository,
  OrgRepository,
  PreferencesRepository,
  TeamMemberRepository,
  TeamRepository,
  UserRepository,
  createTestDb,
  seedDefaultOrg,
  seedServerAdmin,
} from '@agentic-obs/data-layer';
import type { SqliteClient } from '@agentic-obs/data-layer';
import {
  TEAM_MEMBER_PERMISSION_ADMIN,
  TEAM_MEMBER_PERMISSION_MEMBER,
} from '@agentic-obs/common';
import { AuditWriter } from '../auth/audit-writer.js';
import { TeamService, TeamServiceError } from './team-service.js';

async function buildService(db: SqliteClient): Promise<{
  svc: TeamService;
  audit: AuditLogRepository;
  adminId: string;
  orgMainId: string;
}> {
  await seedDefaultOrg(db);
  const { user } = await seedServerAdmin(db);
  const auditRepo = new AuditLogRepository(db);
  const svc = new TeamService({
    teams: new TeamRepository(db),
    teamMembers: new TeamMemberRepository(db),
    preferences: new PreferencesRepository(db),
    db,
    audit: new AuditWriter(auditRepo),
    dashboardAcl: new DashboardAclRepository(db),
  });
  return { svc, audit: auditRepo, adminId: user.id, orgMainId: 'org_main' };
}

describe('TeamService.create', () => {
  let db: SqliteClient;
  beforeEach(() => {
    db = createTestDb();
  });

  it('creates a team scoped to the org, creator is NOT auto-added', async () => {
    // Scenario 1 — "Create team in org → row exists, creator is not auto-added as member".
    const { svc, adminId, orgMainId } = await buildService(db);
    const team = await svc.create(orgMainId, { name: 'SRE' });
    expect(team.id).toBeTruthy();
    expect(team.orgId).toBe(orgMainId);
    expect(team.external).toBe(false);
    const members = await svc.listMembers(orgMainId, team.id);
    expect(members).toHaveLength(0);
    // And the creator id is unused here — we still assert it stayed unlinked.
    expect(members.map((m) => m.userId)).not.toContain(adminId);
  });

  it('stores the optional email', async () => {
    const { svc, orgMainId } = await buildService(db);
    const team = await svc.create(orgMainId, {
      name: 'WithEmail',
      email: 'sre@example.com',
    });
    expect(team.email).toBe('sre@example.com');
  });

  it('rejects missing/empty name with 400', async () => {
    const { svc, orgMainId } = await buildService(db);
    await expect(svc.create(orgMainId, { name: '' })).rejects.toMatchObject({
      kind: 'validation',
      statusCode: 400,
    });
  });

  it('rejects duplicate team name in same org with 409', async () => {
    // Scenario 11 — Team name unique per org.
    const { svc, orgMainId } = await buildService(db);
    await svc.create(orgMainId, { name: 'Dupe' });
    await expect(svc.create(orgMainId, { name: 'Dupe' })).rejects.toMatchObject({
      kind: 'conflict',
      statusCode: 409,
    });
  });

  it('allows same team name in two different orgs', async () => {
    // Scenario 12 — two orgs can each have a team named "SRE".
    const { svc, orgMainId } = await buildService(db);
    const orgs = new OrgRepository(db);
    const other = await orgs.create({ name: 'Other' });
    const a = await svc.create(orgMainId, { name: 'SRE' });
    const b = await svc.create(other.id, { name: 'SRE' });
    expect(a.id).not.toBe(b.id);
    expect(a.orgId).toBe(orgMainId);
    expect(b.orgId).toBe(other.id);
  });

  it('writes an audit log entry', async () => {
    const { svc, audit, orgMainId } = await buildService(db);
    await svc.create(orgMainId, { name: 'Audited' });
    const rows = await audit.query({ action: 'team.created' });
    expect(rows.items.length).toBeGreaterThan(0);
  });
});

describe('TeamService.getById / list', () => {
  let db: SqliteClient;
  beforeEach(() => {
    db = createTestDb();
  });

  it('getById returns null for team in another org', async () => {
    const { svc, orgMainId } = await buildService(db);
    const orgs = new OrgRepository(db);
    const other = await orgs.create({ name: 'OtherOrg' });
    const otherTeam = await svc.create(other.id, { name: 'ForeignTeam' });
    expect(await svc.getById(orgMainId, otherTeam.id)).toBeNull();
  });

  it('list returns org-scoped teams with search filter', async () => {
    const { svc, orgMainId } = await buildService(db);
    await svc.create(orgMainId, { name: 'platform' });
    await svc.create(orgMainId, { name: 'devops' });
    const all = await svc.list(orgMainId);
    expect(all.items.length).toBeGreaterThanOrEqual(2);
    const filtered = await svc.list(orgMainId, { query: 'platf' });
    expect(filtered.items.some((t) => t.name === 'platform')).toBe(true);
    expect(filtered.items.some((t) => t.name === 'devops')).toBe(false);
  });

  it('list filtered by userId returns only teams the user belongs to', async () => {
    // Scenario 2 — List teams filtered by userId.
    const { svc, orgMainId } = await buildService(db);
    const users = new UserRepository(db);
    const u = await users.create({
      email: 'u@x.local',
      name: 'U',
      login: 'u',
      orgId: orgMainId,
    });
    const a = await svc.create(orgMainId, { name: 'Alpha' });
    const b = await svc.create(orgMainId, { name: 'Beta' });
    await svc.addMember(orgMainId, a.id, u.id);
    const mine = await svc.list(orgMainId, { userId: u.id });
    expect(mine.items.map((t) => t.name)).toEqual(['Alpha']);
    expect(mine.items.map((t) => t.name)).not.toContain(b.name);
  });
});

describe('TeamService.update', () => {
  let db: SqliteClient;
  beforeEach(() => {
    db = createTestDb();
  });

  it('updates the name and email', async () => {
    const { svc, orgMainId } = await buildService(db);
    const t = await svc.create(orgMainId, { name: 'Original' });
    const out = await svc.update(orgMainId, t.id, {
      name: 'Renamed',
      email: 'r@x.y',
    });
    expect(out.name).toBe('Renamed');
    expect(out.email).toBe('r@x.y');
  });

  it('404 when team not in org', async () => {
    const { svc, orgMainId } = await buildService(db);
    await expect(svc.update(orgMainId, 'missing', { name: 'x' })).rejects.toMatchObject({
      kind: 'not_found',
    });
  });

  it('409 when renaming to an existing team name', async () => {
    const { svc, orgMainId } = await buildService(db);
    await svc.create(orgMainId, { name: 'A' });
    const b = await svc.create(orgMainId, { name: 'B' });
    await expect(
      svc.update(orgMainId, b.id, { name: 'A' }),
    ).rejects.toMatchObject({ kind: 'conflict' });
  });
});

describe('TeamService.delete', () => {
  let db: SqliteClient;
  beforeEach(() => {
    db = createTestDb();
  });

  it('cascades team_member + team_role + dashboard_acl rows', async () => {
    // Scenario 6 — Delete team → team_member, team_role rows gone; dashboard_acl
    // rows referencing team gone.
    const { svc, orgMainId } = await buildService(db);
    const users = new UserRepository(db);
    const tmRepo = new TeamMemberRepository(db);
    const acl = new DashboardAclRepository(db);

    const u = await users.create({
      email: 'cascade@x.y',
      name: 'C',
      login: 'cascade',
      orgId: orgMainId,
    });
    const t = await svc.create(orgMainId, { name: 'ToCascade' });
    await svc.addMember(orgMainId, t.id, u.id);

    // Fabricate a dashboard_acl row pointing at the team.
    await acl.create({
      orgId: orgMainId,
      folderId: 'some-folder',
      teamId: t.id,
      permission: 1,
    });

    await svc.delete(orgMainId, t.id);

    expect(await svc.getById(orgMainId, t.id)).toBeNull();
    expect(await tmRepo.listByTeam(t.id)).toHaveLength(0);
    expect(await acl.listByTeam(orgMainId, t.id)).toHaveLength(0);
  });

  it('404 when team not in org', async () => {
    const { svc, orgMainId } = await buildService(db);
    await expect(svc.delete(orgMainId, 'missing')).rejects.toMatchObject({
      kind: 'not_found',
    });
  });

  it('cross-org delete attempt is 404 (does not leak)', async () => {
    const { svc, orgMainId } = await buildService(db);
    const orgs = new OrgRepository(db);
    const other = await orgs.create({ name: 'OtherOrg' });
    const t = await svc.create(other.id, { name: 'OtherTeam' });
    await expect(svc.delete(orgMainId, t.id)).rejects.toMatchObject({
      kind: 'not_found',
    });
  });
});

describe('TeamService membership', () => {
  let db: SqliteClient;
  beforeEach(() => {
    db = createTestDb();
  });

  async function seedUser(db: SqliteClient, login: string, orgId = 'org_main') {
    const users = new UserRepository(db);
    return users.create({
      email: `${login}@x.y`,
      name: login,
      login,
      orgId,
    });
  }

  it('addMember creates a team_member row', async () => {
    // Scenario 3.
    const { svc, orgMainId } = await buildService(db);
    const u = await seedUser(db, 'alice');
    const t = await svc.create(orgMainId, { name: 'Team1' });
    const m = await svc.addMember(orgMainId, t.id, u.id);
    expect(m.teamId).toBe(t.id);
    expect(m.userId).toBe(u.id);
    expect(m.external).toBe(false);
    expect(m.permission).toBe(TEAM_MEMBER_PERMISSION_MEMBER);
  });

  it('addMember rejects duplicate with 409', async () => {
    const { svc, orgMainId } = await buildService(db);
    const u = await seedUser(db, 'bob');
    const t = await svc.create(orgMainId, { name: 'Team2' });
    await svc.addMember(orgMainId, t.id, u.id);
    await expect(svc.addMember(orgMainId, t.id, u.id)).rejects.toMatchObject({
      kind: 'conflict',
    });
  });

  it('addMember 404 for unknown team', async () => {
    const { svc, orgMainId } = await buildService(db);
    const u = await seedUser(db, 'ghost');
    await expect(
      svc.addMember(orgMainId, 'team_unknown', u.id),
    ).rejects.toMatchObject({ kind: 'not_found' });
  });

  it('addMember rejects external team (400 "team is externally managed")', async () => {
    // Scenario 9 — External team rejects manual add.
    const { svc, orgMainId } = await buildService(db);
    const u = await seedUser(db, 'ext-user');
    const t = await svc.create(orgMainId, { name: 'IdpTeam', external: true });
    await expect(svc.addMember(orgMainId, t.id, u.id)).rejects.toMatchObject({
      kind: 'external',
      statusCode: 400,
    });
  });

  it('updateMember promotes Member → Admin', async () => {
    // Scenario 4.
    const { svc, orgMainId } = await buildService(db);
    const u = await seedUser(db, 'promoted');
    const t = await svc.create(orgMainId, { name: 'PromoTeam' });
    await svc.addMember(orgMainId, t.id, u.id);
    const after = await svc.updateMember(
      orgMainId,
      t.id,
      u.id,
      TEAM_MEMBER_PERMISSION_ADMIN,
    );
    expect(after.permission).toBe(TEAM_MEMBER_PERMISSION_ADMIN);
  });

  it('updateMember validates permission value', async () => {
    const { svc, orgMainId } = await buildService(db);
    const u = await seedUser(db, 'badperm');
    const t = await svc.create(orgMainId, { name: 'PermTeam' });
    await svc.addMember(orgMainId, t.id, u.id);
    await expect(
      svc.updateMember(orgMainId, t.id, u.id, 3 as unknown as 0),
    ).rejects.toMatchObject({ kind: 'validation' });
  });

  it('removeMember removes a team_member row', async () => {
    // Scenario 5.
    const { svc, orgMainId } = await buildService(db);
    const u = await seedUser(db, 'tbd');
    const t = await svc.create(orgMainId, { name: 'RemoveTeam' });
    await svc.addMember(orgMainId, t.id, u.id);
    await svc.removeMember(orgMainId, t.id, u.id);
    const members = await svc.listMembers(orgMainId, t.id);
    expect(members.some((m) => m.userId === u.id)).toBe(false);
  });

  it('removeMember rejects external team', async () => {
    const { svc, orgMainId } = await buildService(db);
    const u = await seedUser(db, 'locked');
    const t = await svc.create(orgMainId, { name: 'LockedTeam', external: true });
    await expect(
      svc.removeMember(orgMainId, t.id, u.id),
    ).rejects.toMatchObject({ kind: 'external' });
  });

  it('listTeamsForUser returns only teams the user belongs to', async () => {
    const { svc, orgMainId } = await buildService(db);
    const u = await seedUser(db, 'multi');
    const a = await svc.create(orgMainId, { name: 'X' });
    const b = await svc.create(orgMainId, { name: 'Y' });
    await svc.create(orgMainId, { name: 'Z' });
    await svc.addMember(orgMainId, a.id, u.id);
    await svc.addMember(orgMainId, b.id, u.id);
    const teams = await svc.listTeamsForUser(orgMainId, u.id);
    expect(teams.map((t) => t.name).sort()).toEqual(['X', 'Y']);
  });

  it('deleting a user cascades team_member rows (scenario 13 — user side)', async () => {
    const { svc, orgMainId } = await buildService(db);
    const users = new UserRepository(db);
    const u = await seedUser(db, 'rmuser');
    const t = await svc.create(orgMainId, { name: 'Team13' });
    await svc.addMember(orgMainId, t.id, u.id);

    await users.delete(u.id);

    const after = await svc.listMembers(orgMainId, t.id);
    expect(after.some((m) => m.userId === u.id)).toBe(false);
  });
});

describe('TeamService.getTeamPreferences / setTeamPreferences', () => {
  let db: SqliteClient;
  beforeEach(() => {
    db = createTestDb();
  });

  it('get → null when unset; set + get round-trips', async () => {
    const { svc, orgMainId } = await buildService(db);
    const t = await svc.create(orgMainId, { name: 'PrefTeam' });
    expect(await svc.getTeamPreferences(orgMainId, t.id)).toBeNull();
    await svc.setTeamPreferences(orgMainId, t.id, {
      theme: 'dark',
      timezone: 'UTC',
    });
    const out = await svc.getTeamPreferences(orgMainId, t.id);
    expect(out?.theme).toBe('dark');
    expect(out?.timezone).toBe('UTC');
  });

  it('404 when team not in org', async () => {
    const { svc, orgMainId } = await buildService(db);
    await expect(
      svc.getTeamPreferences(orgMainId, 'missing'),
    ).rejects.toMatchObject({ kind: 'not_found' });
  });
});

describe('TeamServiceError', () => {
  it('carries kind + status', () => {
    const err = new TeamServiceError('validation', 'x', 400);
    expect(err.kind).toBe('validation');
    expect(err.statusCode).toBe(400);
    expect(err).toBeInstanceOf(Error);
  });
});
