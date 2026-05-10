/**
 * /api/folders + resource-permission endpoint integration tests (T7.1, T7.3–T7.5).
 *
 * Covers:
 *   - folder CRUD happy path + 403 when a viewer tries to create
 *   - folder delete with alert rules (400 without force, 200 with force)
 *   - dashboard permissions grant + list (with folder cascade)
 *   - alert-rule permissions attach to folder uid
 */

import { describe, it, expect, beforeEach } from 'vitest';
import express, { type Application } from 'express';
import request from 'supertest';
import { sql } from 'drizzle-orm';
import {
  createTestDb,
  seedDefaultOrg,
  seedRbacForOrg,
  UserRepository,
  OrgUserRepository,
  FolderRepository,
  RoleRepository,
  PermissionRepository,
  UserRoleRepository,
  TeamRoleRepository,
  TeamRepository,
  TeamMemberRepository,
  DashboardAclRepository,
} from '@agentic-obs/data-layer';
import type { SqliteClient } from '@agentic-obs/data-layer';
import type { Identity } from '@agentic-obs/common';
import { AccessControlService } from '../../services/accesscontrol-service.js';
import { FolderService } from '../../services/folder-service.js';
import { ResourcePermissionService } from '../../services/resource-permission-service.js';
import { DashboardAclService } from '../../services/dashboard-acl-service.js';
import { createFolderRouter } from '../folders.js';
import { createDashboardPermissionsRouter } from '../dashboard-permissions.js';
import { createAlertRulePermissionsRouter } from '../alert-rule-permissions.js';
import { createResolverRegistry } from '../../rbac/resolvers/index.js';

interface Ctx {
  app: Application;
  db: SqliteClient;
  adminId: string;
  editorId: string;
  viewerId: string;
}

async function buildApp(): Promise<Ctx> {
  const db = createTestDb();
  await seedDefaultOrg(db);
  await seedRbacForOrg(db, 'org_main');

  const users = new UserRepository(db);
  const orgUsers = new OrgUserRepository(db);
  const folders = new FolderRepository(db);
  const teams = new TeamRepository(db);
  const teamMembers = new TeamMemberRepository(db);

  const adminUser = await users.create({
    email: 'admin@t',
    name: 'Admin',
    login: 'admin',
    orgId: 'org_main',
    isAdmin: true,
  });
  await orgUsers.create({
    orgId: 'org_main',
    userId: adminUser.id,
    role: 'Admin',
  });
  const editorUser = await users.create({
    email: 'editor@t',
    name: 'Editor',
    login: 'editor',
    orgId: 'org_main',
  });
  await orgUsers.create({
    orgId: 'org_main',
    userId: editorUser.id,
    role: 'Editor',
  });
  const viewerUser = await users.create({
    email: 'viewer@t',
    name: 'Viewer',
    login: 'viewer',
    orgId: 'org_main',
  });
  await orgUsers.create({
    orgId: 'org_main',
    userId: viewerUser.id,
    role: 'Viewer',
  });

  const legacyAcl = new DashboardAclService({
    dashboardAcl: new DashboardAclRepository(db),
    folders,
    teamMembers,
    db,
  });

  const ac = new AccessControlService({
    permissions: new PermissionRepository(db),
    roles: new RoleRepository(db),
    userRoles: new UserRoleRepository(db),
    teamRoles: new TeamRoleRepository(db),
    teamMembers,
    orgUsers,
    legacyAcl,
    resolvers: (orgId) =>
      createResolverRegistry({
        folders,
        orgId,
        dashboardFolderUid: async (oid, uid) => {
          const r = db.all<{ folder_uid: string | null }>(
            sql`SELECT folder_uid FROM dashboards WHERE org_id = ${oid} AND id = ${uid}`,
          );
          return r[0]?.folder_uid ?? null;
        },
      }),
  });

  const folderService = new FolderService({ folders, db });
  const permissionService = new ResourcePermissionService({
    roles: new RoleRepository(db),
    permissions: new PermissionRepository(db),
    userRoles: new UserRoleRepository(db),
    teamRoles: new TeamRoleRepository(db),
    folders,
    users,
    teams,
  });

  const app = express();
  app.use(express.json());
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
        : who === 'editor'
          ? {
              userId: editorUser.id,
              orgId: 'org_main',
              orgRole: 'Editor',
              isServerAdmin: false,
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
            : null;
    if (identity) {
      (req as express.Request & { auth?: Identity }).auth = identity;
    }
    next();
  });

  app.use(
    '/api/folders',
    createFolderRouter({ folderService, permissionService, ac }),
  );
  app.use(
    '/api/dashboards',
    createDashboardPermissionsRouter({ permissionService, ac, db }),
  );
  app.use(
    '/api/access-control/alert.rules',
    createAlertRulePermissionsRouter({ permissionService, ac }),
  );

  return {
    app,
    db,
    adminId: adminUser.id,
    editorId: editorUser.id,
    viewerId: viewerUser.id,
  };
}

describe('/api/folders — CRUD gated via RBAC', () => {
  let ctx: Ctx;
  beforeEach(async () => {
    ctx = await buildApp();
  });

  it('GET /api/folders returns [] for empty org', async () => {
    const res = await request(ctx.app).get('/api/folders').set('x-test-user', 'admin');
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it('POST /api/folders creates a folder (admin)', async () => {
    const res = await request(ctx.app)
      .post('/api/folders')
      .set('x-test-user', 'admin')
      .send({ title: 'Production' });
    expect(res.status).toBe(200);
    expect(res.body.uid).toBe('production');
  });

  it('POST /api/folders is 403 for viewer (no folders:create)', async () => {
    const res = await request(ctx.app)
      .post('/api/folders')
      .set('x-test-user', 'viewer')
      .send({ title: 'NopeProd' });
    expect(res.status).toBe(403);
  });

  it('GET /api/folders/:uid returns the folder with parents breadcrumb', async () => {
    await request(ctx.app)
      .post('/api/folders')
      .set('x-test-user', 'admin')
      .send({ uid: 'root', title: 'Root' });
    await request(ctx.app)
      .post('/api/folders')
      .set('x-test-user', 'admin')
      .send({ uid: 'sub', title: 'Sub', parentUid: 'root' });
    const res = await request(ctx.app)
      .get('/api/folders/sub')
      .set('x-test-user', 'admin');
    expect(res.status).toBe(200);
    expect(res.body.uid).toBe('sub');
    expect(Array.isArray(res.body.parents)).toBe(true);
    expect(res.body.parents[0].uid).toBe('root');
  });

  it('GET /api/folders/:uid 404 when missing', async () => {
    const res = await request(ctx.app)
      .get('/api/folders/nope')
      .set('x-test-user', 'admin');
    expect(res.status).toBe(404);
  });

  it('PUT /api/folders/:uid renames the folder', async () => {
    await request(ctx.app)
      .post('/api/folders')
      .set('x-test-user', 'admin')
      .send({ uid: 'x', title: 'X' });
    const res = await request(ctx.app)
      .put('/api/folders/x')
      .set('x-test-user', 'admin')
      .send({ title: 'X-renamed' });
    expect(res.status).toBe(200);
    expect(res.body.title).toBe('X-renamed');
  });

  it('DELETE /api/folders/:uid 400 with alert rules and no force flag', async () => {
    await request(ctx.app)
      .post('/api/folders')
      .set('x-test-user', 'admin')
      .send({ uid: 'alr', title: 'Alert' });
    ctx.db.run(sql`
      INSERT INTO alert_rules (
        id, name, description, condition, evaluation_interval_sec,
        severity, state, state_changed_at, created_by,
        fire_count, created_at, updated_at, org_id, folder_uid
      ) VALUES (
        'r_int', 'R', '', 'true', 60, 'warning', 'normal',
        '2026-04-17T00:00:00Z', 'u', 0,
        '2026-04-17T00:00:00Z', '2026-04-17T00:00:00Z',
        'org_main', 'alr'
      )
    `);
    const res = await request(ctx.app)
      .delete('/api/folders/alr')
      .set('x-test-user', 'admin');
    expect(res.status).toBe(400);
  });

  it('DELETE /api/folders/:uid?forceDeleteRules=true succeeds', async () => {
    await request(ctx.app)
      .post('/api/folders')
      .set('x-test-user', 'admin')
      .send({ uid: 'alr2', title: 'Alert2' });
    ctx.db.run(sql`
      INSERT INTO alert_rules (
        id, name, description, condition, evaluation_interval_sec,
        severity, state, state_changed_at, created_by,
        fire_count, created_at, updated_at, org_id, folder_uid
      ) VALUES (
        'r_int2', 'R', '', 'true', 60, 'warning', 'normal',
        '2026-04-17T00:00:00Z', 'u', 0,
        '2026-04-17T00:00:00Z', '2026-04-17T00:00:00Z',
        'org_main', 'alr2'
      )
    `);
    const res = await request(ctx.app)
      .delete('/api/folders/alr2?forceDeleteRules=true')
      .set('x-test-user', 'admin');
    expect(res.status).toBe(200);
  });

  it('GET /api/folders/:uid/counts returns dashboards + subfolders + alertRules', async () => {
    await request(ctx.app)
      .post('/api/folders')
      .set('x-test-user', 'admin')
      .send({ uid: 'cntx', title: 'Counts' });
    ctx.db.run(sql`
      INSERT INTO dashboards (
        id, type, title, description, prompt, user_id, status,
        panels, variables, refresh_interval_sec, datasource_ids,
        use_existing_metrics, created_at, updated_at, org_id, folder_uid
      ) VALUES (
        'dcc', 'dashboard', 'D', '', '', 'u', 'ready',
        '[]', '[]', 30, '[]', 1,
        '2026-04-17T00:00:00Z', '2026-04-17T00:00:00Z', 'org_main', 'cntx'
      )
    `);
    const res = await request(ctx.app)
      .get('/api/folders/cntx/counts')
      .set('x-test-user', 'admin');
    expect(res.status).toBe(200);
    expect(res.body.dashboards).toBe(1);
  });
});

describe('/api/folders/:uid/permissions', () => {
  let ctx: Ctx;
  beforeEach(async () => {
    ctx = await buildApp();
  });

  it('POST grants and GET reflects the grant', async () => {
    await request(ctx.app)
      .post('/api/folders')
      .set('x-test-user', 'admin')
      .send({ uid: 'ff', title: 'FF' });
    const grant = await request(ctx.app)
      .post('/api/folders/ff/permissions')
      .set('x-test-user', 'admin')
      .send({ items: [{ userId: ctx.editorId, permission: 2 }] });
    expect(grant.status).toBe(200);
    const list = await request(ctx.app)
      .get('/api/folders/ff/permissions')
      .set('x-test-user', 'admin');
    expect(list.status).toBe(200);
    expect(list.body).toHaveLength(1);
    expect(list.body[0].userId).toBe(ctx.editorId);
  });

  it('POST to unknown folder returns 404', async () => {
    const res = await request(ctx.app)
      .post('/api/folders/nope/permissions')
      .set('x-test-user', 'admin')
      .send({ items: [] });
    expect(res.status).toBe(404);
  });
});

describe('/api/dashboards/uid/:uid/permissions', () => {
  let ctx: Ctx;
  beforeEach(async () => {
    ctx = await buildApp();
  });

  it('POST + GET round-trip for dashboard permissions', async () => {
    const grant = await request(ctx.app)
      .post('/api/dashboards/uid/dash_int/permissions')
      .set('x-test-user', 'admin')
      .send({ items: [{ userId: ctx.viewerId, permission: 1 }] });
    expect(grant.status).toBe(200);
    const list = await request(ctx.app)
      .get('/api/dashboards/uid/dash_int/permissions')
      .set('x-test-user', 'admin');
    expect(list.status).toBe(200);
    expect(list.body[0].userId).toBe(ctx.viewerId);
  });
});

describe('/api/access-control/alert.rules/:folderUid/permissions', () => {
  let ctx: Ctx;
  beforeEach(async () => {
    ctx = await buildApp();
  });

  it('scopes grants by folder uid', async () => {
    await request(ctx.app)
      .post('/api/folders')
      .set('x-test-user', 'admin')
      .send({ uid: 'al_folder', title: 'Alerts' });
    const grant = await request(ctx.app)
      .post('/api/access-control/alert.rules/al_folder/permissions')
      .set('x-test-user', 'admin')
      .send({ items: [{ userId: ctx.editorId, permission: 2 }] });
    expect(grant.status).toBe(200);
    const list = await request(ctx.app)
      .get('/api/access-control/alert.rules/al_folder/permissions')
      .set('x-test-user', 'admin');
    expect(list.status).toBe(200);
    expect(list.body[0].actions).toContain('alert.rules:read');
    expect(list.body[0].actions).toContain('alert.rules:write');
  });
});
