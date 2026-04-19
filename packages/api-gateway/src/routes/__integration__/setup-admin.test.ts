/**
 * POST /api/setup/admin integration tests (T9.4 / W2 — first-admin bootstrap).
 *
 * Shape:
 *   - empty DB: creates user with is_admin=1, seeds org_user Admin, returns
 *     { userId, orgId } and issues a session cookie.
 *   - bootstrap marker is written on success, locking further bootstrap calls
 *     even if the users table is cleared (W2 / T2.7).
 *   - once bootstrapped: 409.
 *   - validation: 400 on bad email / missing name / short password.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import express, { type Application } from 'express';
import request from 'supertest';
import {
  AuditLogRepository,
  InstanceConfigRepository,
  DatasourceRepository,
  NotificationChannelRepository,
  OrgRepository,
  OrgUserRepository,
  UserAuthTokenRepository,
  UserRepository,
  createTestDb,
  seedDefaultOrg,
} from '@agentic-obs/data-layer';
import type { SqliteClient } from '@agentic-obs/data-layer';
import { createSetupRouter } from '../setup.js';
import { AuditWriter } from '../../auth/audit-writer.js';
import { SessionService } from '../../auth/session-service.js';
import { SetupConfigService } from '../../services/setup-config-service.js';

interface Ctx {
  app: Application;
  db: SqliteClient;
  users: UserRepository;
  orgUsers: OrgUserRepository;
  setupConfig: SetupConfigService;
}

async function buildApp(): Promise<Ctx> {
  const db = createTestDb();
  await seedDefaultOrg(db);

  const users = new UserRepository(db);
  const orgUsers = new OrgUserRepository(db);
  const orgs = new OrgRepository(db);
  const userAuthTokens = new UserAuthTokenRepository(db);
  const auditLog = new AuditLogRepository(db);
  const audit = new AuditWriter(auditLog);
  const sessions = new SessionService(userAuthTokens);
  const setupConfig = new SetupConfigService({
    instanceConfig: new InstanceConfigRepository(db),
    datasources: new DatasourceRepository(db),
    notificationChannels: new NotificationChannelRepository(db),
    audit,
  });

  const app = express();
  app.use(express.json());
  app.use(
    '/api/setup',
    createSetupRouter({
      setupConfig,
      users,
      orgs,
      orgUsers,
      sessions,
      audit,
      defaultOrgId: 'org_main',
    }),
  );
  return { app, db, users, orgUsers, setupConfig };
}

describe('POST /api/setup/admin', () => {
  const prevSecret = process.env['SECRET_KEY'];
  beforeAll(() => {
    process.env['SECRET_KEY'] =
      prevSecret ?? 'test-secret-key-for-setup-admin-integration-xxxxxxxxxxxxxxxxxxx';
  });
  afterAll(() => {
    if (prevSecret === undefined) delete process.env['SECRET_KEY'];
    else process.env['SECRET_KEY'] = prevSecret;
  });

  let ctx: Ctx;
  beforeEach(async () => {
    ctx = await buildApp();
  });

  it('creates the first admin and returns 201 + Set-Cookie', async () => {
    const res = await request(ctx.app)
      .post('/api/setup/admin')
      .send({
        email: 'owner@example.com',
        name: 'Owner',
        login: 'owner',
        password: 'longenoughpassword',
      });
    expect(res.status).toBe(201);
    expect(res.body.userId).toBeTruthy();
    expect(res.body.orgId).toBe('org_main');
    const cookies = res.headers['set-cookie'];
    const cookieHeaders = Array.isArray(cookies) ? cookies : [cookies];
    expect(cookieHeaders.some((c) => c?.startsWith('openobs_session='))).toBe(true);

    const user = await ctx.users.findByEmail('owner@example.com');
    expect(user?.isAdmin).toBe(true);
    const membership = await ctx.orgUsers.findMembership('org_main', user!.id);
    expect(membership?.role).toBe('Admin');
    // Bootstrap marker now set.
    expect(await ctx.setupConfig.isBootstrapped()).toBe(true);
  });

  it('409 once the bootstrap marker is set', async () => {
    await request(ctx.app)
      .post('/api/setup/admin')
      .send({
        email: 'first@example.com',
        name: 'First',
        password: 'longenoughpassword',
      });
    const res = await request(ctx.app)
      .post('/api/setup/admin')
      .send({
        email: 'second@example.com',
        name: 'Second',
        password: 'longenoughpassword',
      });
    expect(res.status).toBe(409);
  });

  it('bootstrap marker blocks even when the users table has been cleared (T2.7)', async () => {
    await request(ctx.app)
      .post('/api/setup/admin')
      .send({
        email: 'first@example.com',
        name: 'First',
        password: 'longenoughpassword',
      });
    // Simulate an accidental DELETE / bad restore.
    const u = await ctx.users.findByEmail('first@example.com');
    if (u) await ctx.users.delete(u.id);
    const res = await request(ctx.app)
      .post('/api/setup/admin')
      .send({
        email: 'second@example.com',
        name: 'Second',
        password: 'longenoughpassword',
      });
    expect(res.status).toBe(409);
  });

  it('400 on invalid email', async () => {
    const res = await request(ctx.app)
      .post('/api/setup/admin')
      .send({
        email: 'not-an-email',
        name: 'X',
        password: 'longenoughpassword',
      });
    expect(res.status).toBe(400);
  });

  it('400 on missing name', async () => {
    const res = await request(ctx.app)
      .post('/api/setup/admin')
      .send({
        email: 'x@example.com',
        password: 'longenoughpassword',
      });
    expect(res.status).toBe(400);
  });

  it('400 on short password', async () => {
    const res = await request(ctx.app)
      .post('/api/setup/admin')
      .send({
        email: 'x@example.com',
        name: 'X',
        password: 'short',
      });
    expect(res.status).toBe(400);
  });

  it('autofills login from email local-part when login is omitted', async () => {
    const res = await request(ctx.app)
      .post('/api/setup/admin')
      .send({
        email: 'jane@example.com',
        name: 'Jane',
        password: 'longenoughpassword',
      });
    expect(res.status).toBe(201);
    const user = await ctx.users.findByEmail('jane@example.com');
    expect(user?.login).toBe('jane');
  });
});

describe('GET /api/setup/status', () => {
  const prevSecret = process.env['SECRET_KEY'];
  beforeAll(() => {
    process.env['SECRET_KEY'] =
      prevSecret ?? 'test-secret-key-for-setup-status-integration-xxxxxxxxxxxxxxxxxxx';
  });
  afterAll(() => {
    if (prevSecret === undefined) delete process.env['SECRET_KEY'];
    else process.env['SECRET_KEY'] = prevSecret;
  });

  it('returns hasAdmin=false on a fresh DB', async () => {
    const { app } = await buildApp();
    const res = await request(app).get('/api/setup/status');
    expect(res.status).toBe(200);
    expect(res.body.hasAdmin).toBe(false);
    expect(res.body.hasLLM).toBe(false);
    expect(res.body.datasourceCount).toBe(0);
  });

  it('returns hasAdmin=true once an admin is created', async () => {
    const { app } = await buildApp();
    await request(app)
      .post('/api/setup/admin')
      .send({
        email: 'y@example.com',
        name: 'Y',
        password: 'longenoughpassword',
      });
    const res = await request(app).get('/api/setup/status');
    expect(res.body.hasAdmin).toBe(true);
    expect(res.body.bootstrappedAt).toBeTruthy();
  });
});
