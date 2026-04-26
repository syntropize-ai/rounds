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
import express, { type Application, type RequestHandler } from 'express';
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
import type { AccessControlSurface } from '../../services/accesscontrol-holder.js';

// Stub RBAC surface — these tests only exercise pre-bootstrap admin-create and
// GET /status, neither of which hits an ac-gated handler. If a test adds a
// reset-endpoint case, provide a real AccessControlService instead.
const stubAc: AccessControlSurface = {
  getUserPermissions: async () => [],
  evaluate: async () => false,
  ensurePermissions: async () => [],
  filterByPermission: async (_id, items) => [...items],
};

interface Ctx {
  app: Application;
  db: SqliteClient;
  users: UserRepository;
  orgUsers: OrgUserRepository;
  setupConfig: SetupConfigService;
}

async function buildApp(opts: {
  authMiddleware?: RequestHandler;
  ac?: AccessControlSurface;
} = {}): Promise<Ctx> {
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
      // Tests that only exercise the pre-bootstrap branch never hit the
      // auth chain, so a 401-returning stub is sufficient — if a test
      // crosses into post-bootstrap, it must provide a real auth mw.
      authMiddleware: opts.authMiddleware ?? ((_req, res) => res.status(401).json({
        error: { code: 'UNAUTHORIZED', message: 'auth required' },
      })),
      ac: opts.ac ?? stubAc,
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

describe('setup config post-bootstrap permissions', () => {
  const prevSecret = process.env['SECRET_KEY'];
  beforeAll(() => {
    process.env['SECRET_KEY'] =
      prevSecret ?? 'test-secret-key-for-setup-config-integration-xxxxxxxxxxxxxxxxxxx';
  });
  afterAll(() => {
    if (prevSecret === undefined) delete process.env['SECRET_KEY'];
    else process.env['SECRET_KEY'] = prevSecret;
  });

  const authed: RequestHandler = (req, _res, next) => {
    (req as typeof req & {
      auth?: {
        userId: string;
        orgId: string;
        orgRole: 'Viewer';
        isServerAdmin: false;
        authenticatedBy: 'session';
      };
    }).auth = {
      userId: 'user_1',
      orgId: 'org_main',
      orgRole: 'Viewer',
      isServerAdmin: false,
      authenticatedBy: 'session',
    };
    next();
  };

  function acWith(allow: boolean): AccessControlSurface {
    return {
      getUserPermissions: async () => [],
      ensurePermissions: async () => [],
      filterByPermission: async (_identity, items) => [...items],
      evaluate: async () => allow,
    };
  }

  it('allows /config before bootstrap without auth', async () => {
    const { app } = await buildApp();
    const res = await request(app).get('/api/setup/config');
    expect(res.status).toBe(200);
  });

  it('requires instance.config:read for /config after bootstrap', async () => {
    const { app, setupConfig } = await buildApp({
      authMiddleware: authed,
      ac: acWith(false),
    });
    await setupConfig.markBootstrapped();

    const res = await request(app).get('/api/setup/config');

    expect(res.status).toBe(403);
    expect(res.body.error.message).toContain('instance.config:read');
  });

  it('requires instance.config:write for LLM probes after bootstrap', async () => {
    const { app, setupConfig } = await buildApp({
      authMiddleware: authed,
      ac: acWith(false),
    });
    await setupConfig.markBootstrapped();

    const res = await request(app)
      .post('/api/setup/llm/models')
      .send({ provider: 'openai' });

    expect(res.status).toBe(403);
    expect(res.body.error.message).toContain('instance.config:write');
  });
});
