/**
 * /api/admin/users integration tests (T9 / G3.c + G1.d).
 *
 * Covers the real user-management endpoints added in Wave 6 cleanup:
 *   POST   /api/admin/users              create + quota + 409 dup
 *   PATCH  /api/admin/users/:id          update profile
 *   DELETE /api/admin/users/:id          delete + revoke sessions
 *   POST   /api/admin/users/:id/password reset password
 *   POST   /api/admin/users/:id/permissions  toggle server admin
 *
 * Plus:
 *   403 when the caller is not a server admin.
 *   Last-admin guard on DELETE and demote-server-admin.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import express, { type Application } from 'express';
import request from 'supertest';
import {
  AuditLogRepository,
  OrgUserRepository,
  QuotaRepository,
  UserAuthTokenRepository,
  UserRepository,
  createTestDb,
  seedDefaultOrg,
} from '@agentic-obs/data-layer';
import type { SqliteClient } from '@agentic-obs/data-layer';
import type { Identity } from '@agentic-obs/common';
import { AuditWriter } from '../../auth/audit-writer.js';
import { SessionService } from '../../auth/session-service.js';
import { createAdminRouter } from '../admin.js';

interface Ctx {
  app: Application;
  db: SqliteClient;
  users: UserRepository;
  orgUsers: OrgUserRepository;
  quotas: QuotaRepository;
  adminId: string;
  viewerId: string;
  setIdentity: (identity: Identity | null) => void;
}

async function buildApp(env: NodeJS.ProcessEnv = {}): Promise<Ctx> {
  const db = createTestDb();
  await seedDefaultOrg(db);

  const users = new UserRepository(db);
  const orgUsers = new OrgUserRepository(db);
  const userAuthTokens = new UserAuthTokenRepository(db);
  const auditLog = new AuditLogRepository(db);
  const quotas = new QuotaRepository(db);
  const audit = new AuditWriter(auditLog);
  const sessions = new SessionService(userAuthTokens);

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

  let currentIdentity: Identity | null = null;

  const app = express();
  app.use(express.json());
  // Test harness auth: stamp `req.auth` from the closure. This lets each test
  // switch identities without standing up the full middleware chain.
  app.use((req, _res, next) => {
    if (currentIdentity) (req as unknown as { auth: Identity }).auth = currentIdentity;
    next();
  });
  app.use(
    '/api/admin',
    createAdminRouter({
      users,
      orgUsers,
      userAuthTokens,
      auditLog,
      sessions,
      audit,
      quotas,
      env,
      defaultOrgId: 'org_main',
    }),
  );

  return {
    app,
    db,
    users,
    orgUsers,
    quotas,
    adminId: adminUser.id,
    viewerId: viewerUser.id,
    setIdentity: (identity) => {
      currentIdentity = identity;
    },
  };
}

function adminIdentity(userId: string): Identity {
  return {
    userId,
    orgId: 'org_main',
    orgRole: 'Admin',
    isServerAdmin: true,
    authenticatedBy: 'session',
    sessionId: 'sess-1',
  };
}

function viewerIdentity(userId: string): Identity {
  return {
    userId,
    orgId: 'org_main',
    orgRole: 'Viewer',
    isServerAdmin: false,
    authenticatedBy: 'session',
    sessionId: 'sess-2',
  };
}

describe('admin router — permissions', () => {
  let ctx: Ctx;
  beforeEach(async () => {
    ctx = await buildApp();
  });

  it('401 when not authenticated', async () => {
    ctx.setIdentity(null);
    const res = await request(ctx.app).get('/api/admin/users');
    expect(res.status).toBe(401);
  });

  it('403 when caller is not a server admin', async () => {
    ctx.setIdentity(viewerIdentity(ctx.viewerId));
    const res = await request(ctx.app).get('/api/admin/users');
    expect(res.status).toBe(403);
  });

  it('200 when caller is a server admin', async () => {
    ctx.setIdentity(adminIdentity(ctx.adminId));
    const res = await request(ctx.app).get('/api/admin/users');
    expect(res.status).toBe(200);
    expect(res.body.users).toBeInstanceOf(Array);
    expect(res.body.totalCount).toBeGreaterThanOrEqual(2);
  });
});

describe('POST /api/admin/users', () => {
  let ctx: Ctx;
  beforeEach(async () => {
    ctx = await buildApp();
    ctx.setIdentity(adminIdentity(ctx.adminId));
  });

  it('creates a new user and writes org_user row', async () => {
    const res = await request(ctx.app)
      .post('/api/admin/users')
      .send({
        email: 'alice@test.local',
        name: 'Alice Example',
        login: 'alice',
        password: 'correcthorsebattery',
        orgRole: 'Editor',
      });
    expect(res.status).toBe(201);
    expect(res.body.login).toBe('alice');
    expect(res.body.role).toBe('Editor');
    const membership = await ctx.orgUsers.findMembership('org_main', res.body.id);
    expect(membership?.role).toBe('Editor');
  });

  it('autofills login from email local-part', async () => {
    const res = await request(ctx.app)
      .post('/api/admin/users')
      .send({
        email: 'bob.smith@test.local',
        name: 'Bob',
        password: 'correcthorsebattery',
      });
    expect(res.status).toBe(201);
    expect(res.body.login).toBe('bob.smith');
  });

  it('409 on duplicate email', async () => {
    await request(ctx.app)
      .post('/api/admin/users')
      .send({
        email: 'dup@test.local',
        name: 'Dup',
        password: 'correcthorsebattery',
      });
    const res = await request(ctx.app)
      .post('/api/admin/users')
      .send({
        email: 'dup@test.local',
        name: 'Dup2',
        login: 'dup2',
        password: 'correcthorsebattery',
      });
    expect(res.status).toBe(409);
    expect(res.body.error?.message).toMatch(/email/);
  });

  it('400 on invalid email', async () => {
    const res = await request(ctx.app)
      .post('/api/admin/users')
      .send({
        email: 'no-at-sign',
        name: 'Bad',
        password: 'correcthorsebattery',
      });
    expect(res.status).toBe(400);
    expect(res.body.error?.message).toMatch(/email/);
  });

  it('400 on short password', async () => {
    const res = await request(ctx.app)
      .post('/api/admin/users')
      .send({
        email: 'short@test.local',
        name: 'Short',
        password: 'short',
      });
    expect(res.status).toBe(400);
    expect(res.body.error?.message).toMatch(/characters/);
  });

  it('enforces users quota via env var', async () => {
    const c2 = await buildApp({ QUOTA_USERS_PER_ORG: '2' });
    c2.setIdentity(adminIdentity(c2.adminId));
    // Already 2 users (admin + viewer) at seed; third should 403.
    const res = await request(c2.app)
      .post('/api/admin/users')
      .send({
        email: 'n@test.local',
        name: 'N',
        password: 'correcthorsebattery',
      });
    expect(res.status).toBe(403);
    expect(res.body.error?.message).toMatch(/Quota/);
  });

  it('enforces users quota via QuotaRepository row', async () => {
    const c2 = await buildApp();
    await c2.quotas.upsertOrgQuota('org_main', 'users', 2);
    c2.setIdentity(adminIdentity(c2.adminId));
    const res = await request(c2.app)
      .post('/api/admin/users')
      .send({
        email: 'n@test.local',
        name: 'N',
        password: 'correcthorsebattery',
      });
    expect(res.status).toBe(403);
  });

  it('treats limit=-1 as unlimited', async () => {
    const c2 = await buildApp({ QUOTA_USERS_PER_ORG: '-1' });
    c2.setIdentity(adminIdentity(c2.adminId));
    for (let i = 0; i < 5; i += 1) {
      const res = await request(c2.app)
        .post('/api/admin/users')
        .send({
          email: `unl${i}@test.local`,
          name: `Unl${i}`,
          password: 'correcthorsebattery',
        });
      expect(res.status).toBe(201);
    }
  });
});

describe('PATCH /api/admin/users/:id', () => {
  let ctx: Ctx;
  beforeEach(async () => {
    ctx = await buildApp();
    ctx.setIdentity(adminIdentity(ctx.adminId));
  });

  it('updates name', async () => {
    const res = await request(ctx.app)
      .patch(`/api/admin/users/${ctx.viewerId}`)
      .send({ name: 'New Name' });
    expect(res.status).toBe(200);
    const u = await ctx.users.findById(ctx.viewerId);
    expect(u?.name).toBe('New Name');
  });

  it('400 when no updatable fields', async () => {
    const res = await request(ctx.app)
      .patch(`/api/admin/users/${ctx.viewerId}`)
      .send({});
    expect(res.status).toBe(400);
  });

  it('404 for missing user', async () => {
    const res = await request(ctx.app)
      .patch('/api/admin/users/nope')
      .send({ name: 'x' });
    expect(res.status).toBe(404);
  });
});

describe('DELETE /api/admin/users/:id', () => {
  let ctx: Ctx;
  beforeEach(async () => {
    ctx = await buildApp();
    ctx.setIdentity(adminIdentity(ctx.adminId));
  });

  it('deletes a non-admin user', async () => {
    const res = await request(ctx.app).delete(`/api/admin/users/${ctx.viewerId}`);
    expect(res.status).toBe(200);
    const u = await ctx.users.findById(ctx.viewerId);
    expect(u).toBeNull();
  });

  it('refuses to delete the last server admin', async () => {
    const res = await request(ctx.app).delete(`/api/admin/users/${ctx.adminId}`);
    expect(res.status).toBe(400);
    expect(res.body.error?.message).toMatch(/last server admin/);
  });

  it('404 for missing user', async () => {
    const res = await request(ctx.app).delete('/api/admin/users/nope');
    expect(res.status).toBe(404);
  });
});

describe('POST /api/admin/users/:id/password', () => {
  let ctx: Ctx;
  beforeEach(async () => {
    ctx = await buildApp();
    ctx.setIdentity(adminIdentity(ctx.adminId));
  });

  it('resets password', async () => {
    const res = await request(ctx.app)
      .post(`/api/admin/users/${ctx.viewerId}/password`)
      .send({ password: 'freshpassword12' });
    expect(res.status).toBe(200);
    const u = await ctx.users.findById(ctx.viewerId);
    // Stored as scrypt salt:hash — just verify it's non-empty and not plaintext.
    expect(u?.password).toBeTruthy();
    expect(u?.password).not.toBe('freshpassword12');
  });

  it('400 on short password', async () => {
    const res = await request(ctx.app)
      .post(`/api/admin/users/${ctx.viewerId}/password`)
      .send({ password: 'short' });
    expect(res.status).toBe(400);
  });

  it('404 for missing user', async () => {
    const res = await request(ctx.app)
      .post('/api/admin/users/nope/password')
      .send({ password: 'longenoughpass' });
    expect(res.status).toBe(404);
  });
});

describe('POST /api/admin/users/:id/permissions', () => {
  let ctx: Ctx;
  beforeEach(async () => {
    ctx = await buildApp();
    ctx.setIdentity(adminIdentity(ctx.adminId));
  });

  it('promotes a user to server admin', async () => {
    const res = await request(ctx.app)
      .post(`/api/admin/users/${ctx.viewerId}/permissions`)
      .send({ isServerAdmin: true });
    expect(res.status).toBe(200);
    const u = await ctx.users.findById(ctx.viewerId);
    expect(u?.isAdmin).toBe(true);
  });

  it('demotes a server admin', async () => {
    // Make the viewer an admin first so there are two.
    await ctx.users.update(ctx.viewerId, { isAdmin: true });
    const res = await request(ctx.app)
      .post(`/api/admin/users/${ctx.adminId}/permissions`)
      .send({ isServerAdmin: false });
    expect(res.status).toBe(200);
  });

  it('refuses to demote the last server admin', async () => {
    const res = await request(ctx.app)
      .post(`/api/admin/users/${ctx.adminId}/permissions`)
      .send({ isServerAdmin: false });
    expect(res.status).toBe(400);
    expect(res.body.error?.message).toMatch(/last server admin/);
  });

  it('400 when body is missing', async () => {
    const res = await request(ctx.app)
      .post(`/api/admin/users/${ctx.viewerId}/permissions`)
      .send({});
    expect(res.status).toBe(400);
  });
});
