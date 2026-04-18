/**
 * /api/teams integration tests (T5.1).
 *
 * Exercises the middleware stack the production server wires — identity
 * injection → orgContext (skipped here since the tests mount the teams router
 * directly) → requirePermission → handler — so RBAC gating is covered
 * end-to-end.
 *
 * Coverage per endpoint: one happy path, one 403 "permission denied", one
 * 404 "resource missing" at minimum, per docs/auth-perm-design/08-api-surface.md
 * §status-codes.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import express, { type Application } from 'express';
import request from 'supertest';
import {
  AuditLogRepository,
  DashboardAclRepository,
  OrgUserRepository,
  PermissionRepository,
  PreferencesRepository,
  RoleRepository,
  TeamMemberRepository,
  TeamRepository,
  TeamRoleRepository,
  UserRepository,
  UserRoleRepository,
  createTestDb,
  seedDefaultOrg,
  seedRbacForOrg,
} from '@agentic-obs/data-layer';
import type { SqliteClient } from '@agentic-obs/data-layer';
import type { Identity } from '@agentic-obs/common';
import { AuditWriter } from '../../auth/audit-writer.js';
import { AccessControlService } from '../../services/accesscontrol-service.js';
import { TeamService } from '../../services/team-service.js';
import { createTeamsRouter } from '../teams.js';

interface Ctx {
  app: Application;
  db: SqliteClient;
  users: UserRepository;
  teams: TeamRepository;
  teamMembers: TeamMemberRepository;
  adminId: string;
  viewerId: string;
  orgMainId: string;
}

async function buildApp(): Promise<Ctx> {
  const db = createTestDb();
  await seedDefaultOrg(db);
  await seedRbacForOrg(db, 'org_main');

  const users = new UserRepository(db);
  const orgUsers = new OrgUserRepository(db);
  const teams = new TeamRepository(db);
  const teamMembers = new TeamMemberRepository(db);
  const preferences = new PreferencesRepository(db);
  const auditRepo = new AuditLogRepository(db);
  const audit = new AuditWriter(auditRepo);

  // Server admin + viewer test identities.
  const adminUser = await users.create({
    email: 'admin@test.local',
    name: 'Admin',
    login: 'admin',
    orgId: 'org_main',
    isAdmin: true,
    emailVerified: true,
  });
  await orgUsers.create({ orgId: 'org_main', userId: adminUser.id, role: 'Admin' });

  const viewerUser = await users.create({
    email: 'viewer@test.local',
    name: 'Viewer',
    login: 'viewer',
    orgId: 'org_main',
    isAdmin: false,
    emailVerified: true,
  });
  await orgUsers.create({
    orgId: 'org_main',
    userId: viewerUser.id,
    role: 'Viewer',
  });

  const ac = new AccessControlService({
    permissions: new PermissionRepository(db),
    roles: new RoleRepository(db),
    userRoles: new UserRoleRepository(db),
    teamRoles: new TeamRoleRepository(db),
    teamMembers,
    orgUsers,
  });
  const svc = new TeamService({
    teams,
    teamMembers,
    preferences,
    db,
    audit,
    dashboardAcl: new DashboardAclRepository(db),
  });

  const app = express();
  app.use(express.json());

  // Test identity injector.
  app.use((req, _res, next) => {
    const who = req.header('x-test-user') ?? 'admin';
    const identity: Identity | null =
      who === 'admin'
        ? {
            userId: adminUser.id,
            orgId: 'org_main',
            orgRole: 'Admin',
            isServerAdmin: true,
            authenticatedBy: 'session',
          }
        : who === 'viewer'
          ? {
              userId: viewerUser.id,
              orgId: 'org_main',
              orgRole: 'Viewer',
              isServerAdmin: false,
              authenticatedBy: 'session',
            }
          : who === 'anon'
            ? null
            : {
                userId: who,
                orgId: 'org_main',
                orgRole: 'Viewer',
                isServerAdmin: false,
                authenticatedBy: 'session',
              };
    if (identity) {
      (req as express.Request & { auth?: Identity }).auth = identity;
    }
    next();
  });

  app.use('/api/teams', createTeamsRouter({ teams: svc, ac }));

  return {
    app,
    db,
    users,
    teams,
    teamMembers,
    adminId: adminUser.id,
    viewerId: viewerUser.id,
    orgMainId: 'org_main',
  };
}

describe('/api/teams — CRUD', () => {
  let ctx: Ctx;
  beforeEach(async () => {
    ctx = await buildApp();
  });

  it('POST /api/teams creates a team (admin)', async () => {
    const res = await request(ctx.app)
      .post('/api/teams')
      .set('x-test-user', 'admin')
      .send({ name: 'Platform' });
    expect(res.status).toBe(200);
    expect(res.body.teamId).toBeTruthy();
  });

  it('POST /api/teams 400 when name missing', async () => {
    const res = await request(ctx.app)
      .post('/api/teams')
      .set('x-test-user', 'admin')
      .send({});
    expect(res.status).toBe(400);
  });

  it('POST /api/teams 403 for viewer (no teams:create)', async () => {
    const res = await request(ctx.app)
      .post('/api/teams')
      .set('x-test-user', 'viewer')
      .send({ name: 'Nope' });
    expect(res.status).toBe(403);
  });

  it('POST /api/teams 409 on duplicate name', async () => {
    await request(ctx.app)
      .post('/api/teams')
      .set('x-test-user', 'admin')
      .send({ name: 'DupeTeam' });
    const res = await request(ctx.app)
      .post('/api/teams')
      .set('x-test-user', 'admin')
      .send({ name: 'DupeTeam' });
    expect(res.status).toBe(409);
  });

  it('GET /api/teams/search returns the teams list (admin)', async () => {
    await request(ctx.app)
      .post('/api/teams')
      .set('x-test-user', 'admin')
      .send({ name: 'Search1' });
    const res = await request(ctx.app)
      .get('/api/teams/search')
      .set('x-test-user', 'admin');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.teams)).toBe(true);
    expect(res.body.teams.some((t: { name: string }) => t.name === 'Search1')).toBe(
      true,
    );
  });

  it('GET /api/teams/search honors the query filter', async () => {
    await request(ctx.app)
      .post('/api/teams')
      .set('x-test-user', 'admin')
      .send({ name: 'alpha-team' });
    await request(ctx.app)
      .post('/api/teams')
      .set('x-test-user', 'admin')
      .send({ name: 'beta-team' });
    const res = await request(ctx.app)
      .get('/api/teams/search?query=alpha')
      .set('x-test-user', 'admin');
    expect(res.status).toBe(200);
    const names = res.body.teams.map((t: { name: string }) => t.name);
    expect(names).toContain('alpha-team');
    expect(names).not.toContain('beta-team');
  });

  it('GET /api/teams/:id returns 200 (viewer with teams:read)', async () => {
    const created = await request(ctx.app)
      .post('/api/teams')
      .set('x-test-user', 'admin')
      .send({ name: 'VisibleTeam' });
    const id = created.body.teamId;
    const res = await request(ctx.app)
      .get(`/api/teams/${id}`)
      .set('x-test-user', 'viewer');
    expect(res.status).toBe(200);
    expect(res.body.name).toBe('VisibleTeam');
  });

  it('GET /api/teams/:id returns 404 on missing team', async () => {
    const res = await request(ctx.app)
      .get('/api/teams/team_missing')
      .set('x-test-user', 'admin');
    expect(res.status).toBe(404);
  });

  it('PUT /api/teams/:id renames (admin)', async () => {
    const created = await request(ctx.app)
      .post('/api/teams')
      .set('x-test-user', 'admin')
      .send({ name: 'OldName' });
    const id = created.body.teamId;
    const res = await request(ctx.app)
      .put(`/api/teams/${id}`)
      .set('x-test-user', 'admin')
      .send({ name: 'NewName' });
    expect(res.status).toBe(200);
    const after = await ctx.teams.findById(id);
    expect(after?.name).toBe('NewName');
  });

  it('PUT /api/teams/:id 403 for viewer', async () => {
    const created = await request(ctx.app)
      .post('/api/teams')
      .set('x-test-user', 'admin')
      .send({ name: 'LockedTeam' });
    const id = created.body.teamId;
    const res = await request(ctx.app)
      .put(`/api/teams/${id}`)
      .set('x-test-user', 'viewer')
      .send({ name: 'sneak' });
    expect(res.status).toBe(403);
  });

  it('PUT /api/teams/:id 404 for missing team', async () => {
    const res = await request(ctx.app)
      .put('/api/teams/team_missing')
      .set('x-test-user', 'admin')
      .send({ name: 'x' });
    expect(res.status).toBe(404);
  });

  it('DELETE /api/teams/:id removes the team (admin)', async () => {
    const created = await request(ctx.app)
      .post('/api/teams')
      .set('x-test-user', 'admin')
      .send({ name: 'ToDelete' });
    const id = created.body.teamId;
    const res = await request(ctx.app)
      .delete(`/api/teams/${id}`)
      .set('x-test-user', 'admin');
    expect(res.status).toBe(200);
    expect(await ctx.teams.findById(id)).toBeNull();
  });

  it('DELETE /api/teams/:id 403 for viewer', async () => {
    const created = await request(ctx.app)
      .post('/api/teams')
      .set('x-test-user', 'admin')
      .send({ name: 'KeepIt' });
    const res = await request(ctx.app)
      .delete(`/api/teams/${created.body.teamId}`)
      .set('x-test-user', 'viewer');
    expect(res.status).toBe(403);
  });
});

describe('/api/teams/:id/members — membership', () => {
  let ctx: Ctx;
  let teamId: string;
  let memberUserId: string;

  beforeEach(async () => {
    ctx = await buildApp();
    const created = await request(ctx.app)
      .post('/api/teams')
      .set('x-test-user', 'admin')
      .send({ name: 'MembershipTeam' });
    teamId = created.body.teamId;
    const u = await ctx.users.create({
      email: 'member@x.y',
      name: 'Member',
      login: 'mem',
      orgId: 'org_main',
    });
    memberUserId = u.id;
  });

  it('POST /api/teams/:id/members adds a user', async () => {
    const res = await request(ctx.app)
      .post(`/api/teams/${teamId}/members`)
      .set('x-test-user', 'admin')
      .send({ userId: memberUserId });
    expect(res.status).toBe(200);
    const members = await ctx.teamMembers.listByTeam(teamId);
    expect(members.some((m) => m.userId === memberUserId)).toBe(true);
  });

  it('POST /api/teams/:id/members 400 when userId missing', async () => {
    const res = await request(ctx.app)
      .post(`/api/teams/${teamId}/members`)
      .set('x-test-user', 'admin')
      .send({});
    expect(res.status).toBe(400);
  });

  it('POST /api/teams/:id/members 403 for viewer', async () => {
    const res = await request(ctx.app)
      .post(`/api/teams/${teamId}/members`)
      .set('x-test-user', 'viewer')
      .send({ userId: memberUserId });
    expect(res.status).toBe(403);
  });

  it('POST /api/teams/:id/members 404 when team missing', async () => {
    const res = await request(ctx.app)
      .post('/api/teams/team_missing/members')
      .set('x-test-user', 'admin')
      .send({ userId: memberUserId });
    expect(res.status).toBe(404);
  });

  it('POST /api/teams/:id/members 409 when already a member', async () => {
    await request(ctx.app)
      .post(`/api/teams/${teamId}/members`)
      .set('x-test-user', 'admin')
      .send({ userId: memberUserId });
    const res = await request(ctx.app)
      .post(`/api/teams/${teamId}/members`)
      .set('x-test-user', 'admin')
      .send({ userId: memberUserId });
    expect(res.status).toBe(409);
  });

  it('POST /api/teams/:id/members rejects external team with 400', async () => {
    // External team — created via the repo direct (the API does not create external teams).
    const ext = await ctx.teams.create({
      orgId: 'org_main',
      name: 'ExternalTeam',
      external: true,
    });
    const res = await request(ctx.app)
      .post(`/api/teams/${ext.id}/members`)
      .set('x-test-user', 'admin')
      .send({ userId: memberUserId });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/externally managed/i);
  });

  it('GET /api/teams/:id/members lists members', async () => {
    await request(ctx.app)
      .post(`/api/teams/${teamId}/members`)
      .set('x-test-user', 'admin')
      .send({ userId: memberUserId });
    const res = await request(ctx.app)
      .get(`/api/teams/${teamId}/members`)
      .set('x-test-user', 'admin');
    expect(res.status).toBe(200);
    expect(res.body.some((m: { userId: string }) => m.userId === memberUserId)).toBe(
      true,
    );
  });

  it('PUT /api/teams/:id/members/:userId updates permission (Member → Admin)', async () => {
    await request(ctx.app)
      .post(`/api/teams/${teamId}/members`)
      .set('x-test-user', 'admin')
      .send({ userId: memberUserId });
    const res = await request(ctx.app)
      .put(`/api/teams/${teamId}/members/${memberUserId}`)
      .set('x-test-user', 'admin')
      .send({ permission: 4 });
    expect(res.status).toBe(200);
    const m = await ctx.teamMembers.findMembership(teamId, memberUserId);
    expect(m?.permission).toBe(4);
  });

  it('PUT /api/teams/:id/members/:userId 400 on bad permission value', async () => {
    await request(ctx.app)
      .post(`/api/teams/${teamId}/members`)
      .set('x-test-user', 'admin')
      .send({ userId: memberUserId });
    const res = await request(ctx.app)
      .put(`/api/teams/${teamId}/members/${memberUserId}`)
      .set('x-test-user', 'admin')
      .send({ permission: 99 });
    expect(res.status).toBe(400);
  });

  it('DELETE /api/teams/:id/members/:userId removes member', async () => {
    await request(ctx.app)
      .post(`/api/teams/${teamId}/members`)
      .set('x-test-user', 'admin')
      .send({ userId: memberUserId });
    const res = await request(ctx.app)
      .delete(`/api/teams/${teamId}/members/${memberUserId}`)
      .set('x-test-user', 'admin');
    expect(res.status).toBe(200);
    const members = await ctx.teamMembers.listByTeam(teamId);
    expect(members.some((m) => m.userId === memberUserId)).toBe(false);
  });

  it('DELETE /api/teams/:id/members/:userId 403 for viewer', async () => {
    await request(ctx.app)
      .post(`/api/teams/${teamId}/members`)
      .set('x-test-user', 'admin')
      .send({ userId: memberUserId });
    const res = await request(ctx.app)
      .delete(`/api/teams/${teamId}/members/${memberUserId}`)
      .set('x-test-user', 'viewer');
    expect(res.status).toBe(403);
  });
});

describe('/api/teams/:id/preferences', () => {
  let ctx: Ctx;
  let teamId: string;

  beforeEach(async () => {
    ctx = await buildApp();
    const created = await request(ctx.app)
      .post('/api/teams')
      .set('x-test-user', 'admin')
      .send({ name: 'PrefsTeam' });
    teamId = created.body.teamId;
  });

  it('GET returns empty defaults when unset', async () => {
    const res = await request(ctx.app)
      .get(`/api/teams/${teamId}/preferences`)
      .set('x-test-user', 'admin');
    expect(res.status).toBe(200);
    expect(res.body.theme).toBe('');
    expect(res.body.homeDashboardUid).toBeNull();
  });

  it('PUT stores preferences and GET returns them', async () => {
    const put = await request(ctx.app)
      .put(`/api/teams/${teamId}/preferences`)
      .set('x-test-user', 'admin')
      .send({ theme: 'dark', timezone: 'UTC' });
    expect(put.status).toBe(200);
    const get = await request(ctx.app)
      .get(`/api/teams/${teamId}/preferences`)
      .set('x-test-user', 'admin');
    expect(get.status).toBe(200);
    expect(get.body.theme).toBe('dark');
    expect(get.body.timezone).toBe('UTC');
  });

  it('PUT 403 for viewer (teams:write required)', async () => {
    const res = await request(ctx.app)
      .put(`/api/teams/${teamId}/preferences`)
      .set('x-test-user', 'viewer')
      .send({ theme: 'light' });
    expect(res.status).toBe(403);
  });

  it('PUT 404 when team missing', async () => {
    const res = await request(ctx.app)
      .put('/api/teams/team_missing/preferences')
      .set('x-test-user', 'admin')
      .send({ theme: 'dark' });
    expect(res.status).toBe(404);
  });
});
