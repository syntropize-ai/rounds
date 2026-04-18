import { describe, it, expect, beforeEach } from 'vitest';
import express, { type Application } from 'express';
import request from 'supertest';
import {
  ApiKeyRepository,
  AuditLogRepository,
  OrgRepository,
  OrgUserRepository,
  UserAuthRepository,
  UserAuthTokenRepository,
  UserRepository,
  createTestDb,
} from '@agentic-obs/data-layer';
import { AuditWriter } from '../../auth/audit-writer.js';
import { hashPassword, LocalProvider } from '../../auth/local-provider.js';
import {
  SESSION_COOKIE_NAME,
  SessionService,
} from '../../auth/session-service.js';
import { createAuthRouter } from '../auth.js';
import { createAuthMiddleware } from '../../middleware/auth.js';
import { createUserRouter } from '../user.js';

/**
 * Thin harness that builds an express app with just the /api/login, /api/logout
 * and /api/user routers. No JWT, no global middleware — we're testing the
 * T2 contract surface.
 */
async function buildTestApp(): Promise<{
  app: Application;
  users: UserRepository;
  orgUsers: OrgUserRepository;
  sessions: SessionService;
  auditLog: AuditLogRepository;
}> {
  const db = createTestDb();
  const users = new UserRepository(db);
  const userAuth = new UserAuthRepository(db);
  const orgUsers = new OrgUserRepository(db);
  const userAuthTokens = new UserAuthTokenRepository(db);
  const apiKeys = new ApiKeyRepository(db);
  const auditLog = new AuditLogRepository(db);
  const _orgs = new OrgRepository(db);
  const sessions = new SessionService(userAuthTokens);
  const local = new LocalProvider(users);
  const audit = new AuditWriter(auditLog);

  const app = express();
  app.use(express.json());
  const authMw = createAuthMiddleware({ sessions, users, orgUsers, apiKeys });
  app.use(
    '/api/user',
    (req, res, next) => authMw(req, res, next),
    createUserRouter({
      users,
      userAuth,
      orgUsers,
      sessions,
      audit,
    }),
  );
  app.use(
    '/api',
    createAuthRouter({
      users,
      userAuth,
      orgUsers,
      sessions,
      local,
      audit,
      defaultOrgId: 'org_main',
    }),
  );
  return { app, users, orgUsers, sessions, auditLog };
}

async function seed(users: UserRepository, orgUsers: OrgUserRepository) {
  const pw = await hashPassword('correcthorsebatterystaple');
  const user = await users.create({
    email: 'alice@openobs.local',
    name: 'Alice',
    login: 'alice',
    password: pw,
    orgId: 'org_main',
  });
  await orgUsers.create({ orgId: 'org_main', userId: user.id, role: 'Editor' });
  return user;
}

describe('POST /api/login (integration)', () => {
  let ctx: Awaited<ReturnType<typeof buildTestApp>>;
  beforeEach(async () => {
    ctx = await buildTestApp();
  });

  it('200 with session cookie on happy path', async () => {
    await seed(ctx.users, ctx.orgUsers);
    const res = await request(ctx.app)
      .post('/api/login')
      .send({ user: 'alice', password: 'correcthorsebatterystaple' });
    expect(res.status).toBe(200);
    expect(res.body.message).toBe('Logged in');
    const sc = res.headers['set-cookie'];
    const cookies = Array.isArray(sc) ? sc : [sc];
    expect(cookies.join(';')).toContain(SESSION_COOKIE_NAME);
  });

  it('401 on wrong password', async () => {
    await seed(ctx.users, ctx.orgUsers);
    const res = await request(ctx.app)
      .post('/api/login')
      .send({ user: 'alice', password: 'bad' });
    expect(res.status).toBe(401);
    expect(res.body.message).toBe('invalid username or password');
  });

  it('401 on unknown user (same message)', async () => {
    const res = await request(ctx.app)
      .post('/api/login')
      .send({ user: 'nobody', password: 'whatever' });
    expect(res.status).toBe(401);
    expect(res.body.message).toBe('invalid username or password');
  });

  it('401 for disabled user', async () => {
    const pw = await hashPassword('correcthorsebatterystaple');
    await ctx.users.create({
      email: 'b@x.com',
      name: 'B',
      login: 'bob',
      password: pw,
      orgId: 'org_main',
      isDisabled: true,
    });
    const res = await request(ctx.app)
      .post('/api/login')
      .send({ user: 'bob', password: 'correcthorsebatterystaple' });
    expect(res.status).toBe(401);
  });

  it('400 when user or password missing', async () => {
    const res = await request(ctx.app).post('/api/login').send({});
    expect(res.status).toBe(400);
  });

  it('429 after 5 failures', async () => {
    await seed(ctx.users, ctx.orgUsers);
    for (let i = 0; i < 5; i++) {
      await request(ctx.app)
        .post('/api/login')
        .send({ user: 'alice', password: 'bad' });
    }
    const res = await request(ctx.app)
      .post('/api/login')
      .send({ user: 'alice', password: 'bad' });
    expect(res.status).toBe(429);
  });

  it('audit log records success', async () => {
    await seed(ctx.users, ctx.orgUsers);
    await request(ctx.app)
      .post('/api/login')
      .send({ user: 'alice', password: 'correcthorsebatterystaple' });
    // Audit write is fire-and-forget; give the microtask queue a tick.
    await new Promise((r) => setImmediate(r));
    const { total } = await ctx.auditLog.query({ action: 'user.login' });
    expect(total).toBeGreaterThanOrEqual(1);
  });

  it('audit log records failure', async () => {
    await request(ctx.app)
      .post('/api/login')
      .send({ user: 'ghost', password: 'x' });
    await new Promise((r) => setImmediate(r));
    const { total } = await ctx.auditLog.query({
      action: 'user.login_failed',
    });
    expect(total).toBeGreaterThanOrEqual(1);
  });

  // T6 acceptance — SA login must be rejected at the login endpoint.
  it('403 when login targets a service account', async () => {
    await ctx.users.create({
      email: 'bot@t.local',
      name: 'Bot',
      login: 'sa-bot',
      password: null,
      orgId: 'org_main',
      isServiceAccount: true,
    });
    const res = await request(ctx.app)
      .post('/api/login')
      .send({ user: 'sa-bot', password: 'irrelevant' });
    expect(res.status).toBe(403);
    expect(res.body.message).toMatch(/service account/i);
  });
});

describe('GET /api/user (integration)', () => {
  let ctx: Awaited<ReturnType<typeof buildTestApp>>;
  beforeEach(async () => {
    ctx = await buildTestApp();
  });

  it('401 without session cookie', async () => {
    const res = await request(ctx.app).get('/api/user');
    expect(res.status).toBe(401);
  });

  it('returns current user with session cookie', async () => {
    const user = await seed(ctx.users, ctx.orgUsers);
    const login = await request(ctx.app)
      .post('/api/login')
      .send({ user: 'alice', password: 'correcthorsebatterystaple' });
    const sc = login.headers['set-cookie'];
    const cookies = Array.isArray(sc) ? sc : [sc];
    const res = await request(ctx.app)
      .get('/api/user')
      .set('Cookie', cookies.join('; '));
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(user.id);
    expect(res.body.login).toBe('alice');
    expect(res.body.isGrafanaAdmin).toBe(false);
    expect(Array.isArray(res.body.orgs)).toBe(true);
  });
});

describe('POST /api/logout (integration)', () => {
  let ctx: Awaited<ReturnType<typeof buildTestApp>>;
  beforeEach(async () => {
    ctx = await buildTestApp();
  });

  it('revokes the current session and clears cookie', async () => {
    await seed(ctx.users, ctx.orgUsers);
    const login = await request(ctx.app)
      .post('/api/login')
      .send({ user: 'alice', password: 'correcthorsebatterystaple' });
    const sc = login.headers['set-cookie'];
    const cookies = Array.isArray(sc) ? sc : [sc];
    const res = await request(ctx.app)
      .post('/api/logout')
      .set('Cookie', cookies.join('; '));
    expect(res.status).toBe(200);
    const clear = (res.headers['set-cookie'] ?? []) as string[];
    const joined = Array.isArray(clear) ? clear.join(';') : clear;
    expect(joined).toContain('Max-Age=0');
  });
});

describe('GET /api/login/providers (integration)', () => {
  it('returns the local provider always', async () => {
    const { app } = await buildTestApp();
    const res = await request(app).get('/api/login/providers');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.find((p: { id: string }) => p.id === 'local')).toBeTruthy();
  });
});

describe('Session rotation (integration)', () => {
  it('previous token is valid in grace window', async () => {
    const db = createTestDb();
    const users = new UserRepository(db);
    const orgUsers = new OrgUserRepository(db);
    const userAuthTokens = new UserAuthTokenRepository(db);
    const clock = { t: 1_000_000 };
    const sessions = new SessionService(userAuthTokens, {
      now: () => clock.t,
      rotationIntervalMs: 1000,
      rotationGraceMs: 10_000,
    });
    const user = await users.create({
      email: 'a@x.com',
      login: 'alice',
      name: 'A',
      orgId: 'org_main',
    });
    await orgUsers.create({ orgId: 'org_main', userId: user.id, role: 'Viewer' });
    const first = await sessions.create(user.id, 'ua', 'ip');
    clock.t += 2000;
    const rotated = await sessions.rotate(first.row.id);
    expect(rotated).not.toBeNull();
    expect(await sessions.lookupByToken(first.token)).not.toBeNull();
    expect(await sessions.lookupByToken(rotated!.token)).not.toBeNull();
    clock.t += 15_000;
    expect(await sessions.lookupByToken(first.token)).toBeNull();
    expect(await sessions.lookupByToken(rotated!.token)).not.toBeNull();
  });
});
