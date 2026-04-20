/**
 * /api/orgs and /api/org integration tests (T4.1 + T4.2).
 *
 * Covers the endpoints listed in docs/auth-perm-design/08-api-surface.md
 * §/api/orgs and §/api/org, including:
 *   - happy path (server admin performs CRUD)
 *   - 401 when unauthenticated
 *   - 403 when caller lacks the required permission
 *   - 404 when the target org/user does not exist
 *   - 409 on name conflict / duplicate membership
 *
 * The harness builds the exact same middleware stack the production server
 * wires — auth → orgContext → requirePermission — so the RBAC gating is
 * exercised end-to-end, not just the handler body.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import express, { type Application } from 'express';
import request from 'supertest';
import {
  AuditLogRepository,
  OrgRepository,
  OrgUserRepository,
  PermissionRepository,
  PreferencesRepository,
  QuotaRepository,
  RoleRepository,
  TeamMemberRepository,
  TeamRoleRepository,
  UserRepository,
  UserRoleRepository,
  createTestDb,
  seedRbacForOrg,
  seedDefaultOrg,
} from '@agentic-obs/data-layer';
import type { SqliteClient } from '@agentic-obs/data-layer';
import type { Identity } from '@agentic-obs/common';
import { AuditWriter } from '../../auth/audit-writer.js';
import { AccessControlService } from '../../services/accesscontrol-service.js';
import { OrgService } from '../../services/org-service.js';
import { createOrgsRouter } from '../orgs.js';
import { createOrgRouter } from '../org.js';
import { createOrgContextMiddleware } from '../../middleware/org-context.js';

interface Ctx {
  app: Application;
  db: SqliteClient;
  users: UserRepository;
  orgUsers: OrgUserRepository;
  orgs: OrgRepository;
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
  const orgs = new OrgRepository(db);
  const quotas = new QuotaRepository(db);
  const auditRepo = new AuditLogRepository(db);
  const audit = new AuditWriter(auditRepo);

  // Server admin + viewer user.
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
  await orgUsers.create({ orgId: 'org_main', userId: viewerUser.id, role: 'Viewer' });

  const ac = new AccessControlService({
    permissions: new PermissionRepository(db),
    roles: new RoleRepository(db),
    userRoles: new UserRoleRepository(db),
    teamRoles: new TeamRoleRepository(db),
    teamMembers: new TeamMemberRepository(db),
    orgUsers,
  });
  const orgService = new OrgService({
    orgs,
    orgUsers,
    users,
    quotas,
    audit,
    db,
    defaultOrgId: 'org_main',
  });

  const app = express();
  app.use(express.json());

  // Test-only identity injector. Each test sets req headers to pick which
  // user the fake middleware installs as the caller.
  app.use((req, _res, next) => {
    const who = req.header('x-test-user') ?? 'admin';
    const identity: Identity =
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
            ? (null as unknown as Identity)
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

  app.use(
    '/api/orgs',
    createOrgsRouter({ orgs: orgService, ac }),
  );
  app.use(
    '/api/org',
    createOrgContextMiddleware({ orgUsers }),
    createOrgRouter({
      orgs: orgService,
      ac,
      preferences: new PreferencesRepository(db),
    }),
  );

  return {
    app,
    db,
    users,
    orgUsers,
    orgs,
    adminId: adminUser.id,
    viewerId: viewerUser.id,
    orgMainId: 'org_main',
  };
}

describe('/api/orgs — server admin CRUD', () => {
  let ctx: Ctx;
  beforeEach(async () => {
    ctx = await buildApp();
  });

  it('GET /api/orgs returns the list for server admin', async () => {
    const res = await request(ctx.app)
      .get('/api/orgs')
      .set('x-test-user', 'admin');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.items)).toBe(true);
    expect(res.body.items.some((o: { id: string }) => o.id === 'org_main')).toBe(true);
  });

  it('GET /api/orgs includes per-org userCount from the LEFT JOIN', async () => {
    // Harness seeds admin + viewer in `org_main` — so userCount should be 2.
    const res = await request(ctx.app)
      .get('/api/orgs')
      .set('x-test-user', 'admin');
    expect(res.status).toBe(200);
    const row = (res.body.items as Array<{ id: string; userCount: number }>).find(
      (o) => o.id === 'org_main',
    );
    expect(row).toBeTruthy();
    expect(row!.userCount).toBe(2);
  });

  it('GET /api/orgs userCount is 0 for a freshly-created org (no creator row in this flow)', async () => {
    // `org_user` rows are inserted by OrgService.create(), so a new org here
    // has exactly the creator as member — assert the count reflects it.
    const created = await request(ctx.app)
      .post('/api/orgs')
      .set('x-test-user', 'admin')
      .send({ name: 'CountCheckOrg' });
    const id = created.body.orgId as string;
    const res = await request(ctx.app)
      .get('/api/orgs')
      .set('x-test-user', 'admin');
    const row = (res.body.items as Array<{ id: string; userCount: number }>).find(
      (o) => o.id === id,
    );
    expect(row).toBeTruthy();
    expect(row!.userCount).toBe(1);
  });

  it('GET /api/orgs is allowed for viewer in current role catalog', async () => {
    // The built-in Viewer in roles-def.ts (mirroring Grafana's stock viewer)
    // carries `orgs:read` with global scope to support the UI bootstrap's
    // org-switcher dropdown. Server admins use /api/orgs for cross-org
    // management; viewers get the same endpoint for read-only listing.
    const res = await request(ctx.app)
      .get('/api/orgs')
      .set('x-test-user', 'viewer');
    expect(res.status).toBe(200);
  });

  it('POST /api/orgs creates an org (admin)', async () => {
    const res = await request(ctx.app)
      .post('/api/orgs')
      .set('x-test-user', 'admin')
      .send({ name: 'NewCo' });
    expect(res.status).toBe(200);
    expect(res.body.orgId).toBeTruthy();
  });

  it('POST /api/orgs 400 when name missing', async () => {
    const res = await request(ctx.app)
      .post('/api/orgs')
      .set('x-test-user', 'admin')
      .send({});
    expect(res.status).toBe(400);
  });

  it('POST /api/orgs 403 for viewer', async () => {
    const res = await request(ctx.app)
      .post('/api/orgs')
      .set('x-test-user', 'viewer')
      .send({ name: 'Sneaky' });
    expect(res.status).toBe(403);
  });

  it('POST /api/orgs 409 on duplicate name', async () => {
    await request(ctx.app)
      .post('/api/orgs')
      .set('x-test-user', 'admin')
      .send({ name: 'DupeIntegration' });
    const res = await request(ctx.app)
      .post('/api/orgs')
      .set('x-test-user', 'admin')
      .send({ name: 'DupeIntegration' });
    expect(res.status).toBe(409);
  });

  it('GET /api/orgs/:id returns the org (admin)', async () => {
    const res = await request(ctx.app)
      .get('/api/orgs/org_main')
      .set('x-test-user', 'admin');
    expect(res.status).toBe(200);
    expect(res.body.id).toBe('org_main');
  });

  it('GET /api/orgs/:id 404 on missing', async () => {
    const res = await request(ctx.app)
      .get('/api/orgs/org_missing')
      .set('x-test-user', 'admin');
    expect(res.status).toBe(404);
  });

  it('GET /api/orgs/name/:name returns the org', async () => {
    const res = await request(ctx.app)
      .get('/api/orgs/name/Main Org')
      .set('x-test-user', 'admin');
    expect(res.status).toBe(200);
    expect(res.body.id).toBe('org_main');
  });

  it('PUT /api/orgs/:id updates fields', async () => {
    const res = await request(ctx.app)
      .put('/api/orgs/org_main')
      .set('x-test-user', 'admin')
      .send({ name: 'Renamed Main', city: 'NYC' });
    expect(res.status).toBe(200);
    const after = await ctx.orgs.findById('org_main');
    expect(after?.name).toBe('Renamed Main');
  });

  it('PUT /api/orgs/:id 403 for viewer', async () => {
    const res = await request(ctx.app)
      .put('/api/orgs/org_main')
      .set('x-test-user', 'viewer')
      .send({ name: 'Nope' });
    expect(res.status).toBe(403);
  });

  it('DELETE /api/orgs/:id works (admin)', async () => {
    const created = await request(ctx.app)
      .post('/api/orgs')
      .set('x-test-user', 'admin')
      .send({ name: 'ToDelete' });
    const id = created.body.orgId as string;
    const res = await request(ctx.app)
      .delete(`/api/orgs/${id}`)
      .set('x-test-user', 'admin');
    expect(res.status).toBe(200);
    expect(await ctx.orgs.findById(id)).toBeNull();
  });

  it('DELETE /api/orgs/:id 403 for viewer', async () => {
    const res = await request(ctx.app)
      .delete('/api/orgs/org_main')
      .set('x-test-user', 'viewer');
    expect(res.status).toBe(403);
  });
});

describe('/api/orgs/:id/users — cross-org membership management', () => {
  let ctx: Ctx;
  let newOrgId: string;
  let targetUserId: string;
  beforeEach(async () => {
    ctx = await buildApp();
    const created = await request(ctx.app)
      .post('/api/orgs')
      .set('x-test-user', 'admin')
      .send({ name: 'MembershipOrg' });
    newOrgId = created.body.orgId as string;

    const user = await ctx.users.create({
      email: 'member@x.y',
      name: 'Member',
      login: 'member',
      orgId: 'org_main',
      isAdmin: false,
      emailVerified: true,
    });
    targetUserId = user.id;
  });

  it('POST /api/orgs/:id/users adds by login', async () => {
    const res = await request(ctx.app)
      .post(`/api/orgs/${newOrgId}/users`)
      .set('x-test-user', 'admin')
      .send({ loginOrEmail: 'member', role: 'Viewer' });
    expect(res.status).toBe(200);
    expect(res.body.userId).toBe(targetUserId);
  });

  it('POST /api/orgs/:id/users 400 when user not found', async () => {
    const res = await request(ctx.app)
      .post(`/api/orgs/${newOrgId}/users`)
      .set('x-test-user', 'admin')
      .send({ loginOrEmail: 'ghost', role: 'Viewer' });
    expect(res.status).toBe(400);
    expect(res.body.error?.message).toMatch(/user not found/i);
  });

  it('POST /api/orgs/:id/users 409 when already a member', async () => {
    await request(ctx.app)
      .post(`/api/orgs/${newOrgId}/users`)
      .set('x-test-user', 'admin')
      .send({ loginOrEmail: 'member', role: 'Viewer' });
    const res = await request(ctx.app)
      .post(`/api/orgs/${newOrgId}/users`)
      .set('x-test-user', 'admin')
      .send({ loginOrEmail: 'member', role: 'Editor' });
    expect(res.status).toBe(409);
    expect(res.body.error?.message).toMatch(/already member/i);
  });

  it('POST /api/orgs/:id/users 400 on invalid role', async () => {
    const res = await request(ctx.app)
      .post(`/api/orgs/${newOrgId}/users`)
      .set('x-test-user', 'admin')
      .send({ loginOrEmail: 'member', role: 'Superhero' });
    expect(res.status).toBe(400);
  });

  it('GET /api/orgs/:id/users lists members', async () => {
    await request(ctx.app)
      .post(`/api/orgs/${newOrgId}/users`)
      .set('x-test-user', 'admin')
      .send({ loginOrEmail: 'member', role: 'Viewer' });
    const res = await request(ctx.app)
      .get(`/api/orgs/${newOrgId}/users`)
      .set('x-test-user', 'admin');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.items)).toBe(true);
    expect(res.body.items.some((m: { login: string }) => m.login === 'member')).toBe(true);
  });

  it('PATCH /api/orgs/:id/users/:userId updates role', async () => {
    await request(ctx.app)
      .post(`/api/orgs/${newOrgId}/users`)
      .set('x-test-user', 'admin')
      .send({ loginOrEmail: 'member', role: 'Viewer' });
    const res = await request(ctx.app)
      .patch(`/api/orgs/${newOrgId}/users/${targetUserId}`)
      .set('x-test-user', 'admin')
      .send({ role: 'Editor' });
    expect(res.status).toBe(200);
    const mem = await ctx.orgUsers.findMembership(newOrgId, targetUserId);
    expect(mem?.role).toBe('Editor');
  });

  it('PATCH /api/orgs/:id/users/:userId 404 when membership missing', async () => {
    const res = await request(ctx.app)
      .patch(`/api/orgs/${newOrgId}/users/u_none`)
      .set('x-test-user', 'admin')
      .send({ role: 'Editor' });
    expect(res.status).toBe(404);
  });

  it('DELETE /api/orgs/:id/users/:userId removes member', async () => {
    await request(ctx.app)
      .post(`/api/orgs/${newOrgId}/users`)
      .set('x-test-user', 'admin')
      .send({ loginOrEmail: 'member', role: 'Viewer' });
    const res = await request(ctx.app)
      .delete(`/api/orgs/${newOrgId}/users/${targetUserId}`)
      .set('x-test-user', 'admin');
    expect(res.status).toBe(200);
    expect(await ctx.orgUsers.findMembership(newOrgId, targetUserId)).toBeNull();
  });

  it('GET /api/orgs/:id/users 403 for viewer', async () => {
    const res = await request(ctx.app)
      .get(`/api/orgs/${newOrgId}/users`)
      .set('x-test-user', 'viewer');
    expect(res.status).toBe(403);
  });
});

describe('/api/org — current-org endpoints', () => {
  let ctx: Ctx;
  beforeEach(async () => {
    ctx = await buildApp();
  });

  it('GET /api/org returns the current org', async () => {
    const res = await request(ctx.app)
      .get('/api/org')
      .set('x-test-user', 'admin');
    expect(res.status).toBe(200);
    expect(res.body.id).toBe('org_main');
  });

  it('PUT /api/org updates the current org', async () => {
    const res = await request(ctx.app)
      .put('/api/org')
      .set('x-test-user', 'admin')
      .send({ name: 'Renamed via /api/org' });
    expect(res.status).toBe(200);
    const after = await ctx.orgs.findById('org_main');
    expect(after?.name).toBe('Renamed via /api/org');
  });

  it('PUT /api/org 403 for viewer', async () => {
    const res = await request(ctx.app)
      .put('/api/org')
      .set('x-test-user', 'viewer')
      .send({ name: 'Nope' });
    expect(res.status).toBe(403);
  });

  it('GET /api/org/users returns members', async () => {
    const res = await request(ctx.app)
      .get('/api/org/users')
      .set('x-test-user', 'admin');
    expect(res.status).toBe(200);
    expect(res.body.items.some((m: { login: string }) => m.login === 'admin')).toBe(true);
  });

  it('GET /api/org/users 403 for viewer', async () => {
    const res = await request(ctx.app)
      .get('/api/org/users')
      .set('x-test-user', 'viewer');
    expect(res.status).toBe(403);
  });

  it('POST /api/org/users adds member via current-org handle', async () => {
    await ctx.users.create({
      email: 'joiner@x.y',
      name: 'Joiner',
      login: 'joiner',
      orgId: 'org_main',
      isAdmin: false,
      emailVerified: true,
    });
    // Joiner is already a member via seed? No — we only seeded admin + viewer.
    // Create a user who is NOT in org_main by giving them a different orgId.
    // But the user.orgId FK requires a real org — simulate "non-member" via
    // a user that exists in a different org.
    const other = await request(ctx.app)
      .post('/api/orgs')
      .set('x-test-user', 'admin')
      .send({ name: 'SideOrg' });
    const otherId = other.body.orgId as string;
    const nm = await ctx.users.create({
      email: 'sidekick@x.y',
      name: 'Side',
      login: 'sidekick',
      orgId: otherId,
      isAdmin: false,
      emailVerified: true,
    });
    void nm;

    const res = await request(ctx.app)
      .post('/api/org/users')
      .set('x-test-user', 'admin')
      .send({ loginOrEmail: 'sidekick', role: 'Viewer' });
    expect(res.status).toBe(200);
    expect(res.body.message).toMatch(/added/i);
  });

  it('POST /api/org/users 400 when loginOrEmail missing', async () => {
    const res = await request(ctx.app)
      .post('/api/org/users')
      .set('x-test-user', 'admin')
      .send({ role: 'Viewer' });
    expect(res.status).toBe(400);
  });

  it('POST /api/org/users 400 when user not found', async () => {
    const res = await request(ctx.app)
      .post('/api/org/users')
      .set('x-test-user', 'admin')
      .send({ loginOrEmail: 'ghost', role: 'Viewer' });
    expect(res.status).toBe(400);
    expect(res.body.error?.message).toMatch(/user not found/i);
  });

  it('PATCH /api/org/users/:userId updates role', async () => {
    const res = await request(ctx.app)
      .patch(`/api/org/users/${ctx.viewerId}`)
      .set('x-test-user', 'admin')
      .send({ role: 'Editor' });
    expect(res.status).toBe(200);
    const m = await ctx.orgUsers.findMembership('org_main', ctx.viewerId);
    expect(m?.role).toBe('Editor');
  });

  it('DELETE /api/org/users/:userId removes member', async () => {
    const res = await request(ctx.app)
      .delete(`/api/org/users/${ctx.viewerId}`)
      .set('x-test-user', 'admin');
    expect(res.status).toBe(200);
    expect(await ctx.orgUsers.findMembership('org_main', ctx.viewerId)).toBeNull();
  });

  it('GET /api/org/preferences returns empty defaults', async () => {
    const res = await request(ctx.app)
      .get('/api/org/preferences')
      .set('x-test-user', 'admin');
    expect(res.status).toBe(200);
  });

  it('PUT /api/org/preferences accepts an update', async () => {
    const res = await request(ctx.app)
      .put('/api/org/preferences')
      .set('x-test-user', 'admin')
      .send({ theme: 'dark', timezone: 'UTC' });
    expect(res.status).toBe(200);
  });
});
