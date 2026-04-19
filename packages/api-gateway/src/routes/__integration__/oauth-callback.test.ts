import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import express, { type Application } from 'express';
import request from 'supertest';
import {
  ApiKeyRepository,
  AuditLogRepository,
  OrgUserRepository,
  UserAuthRepository,
  UserAuthTokenRepository,
  UserRepository,
  createTestDb,
} from '@agentic-obs/data-layer';
import { AuditWriter } from '../../auth/audit-writer.js';
import { LocalProvider } from '../../auth/local-provider.js';
import { SessionService } from '../../auth/session-service.js';
import { createAuthRouter } from '../auth.js';
import {
  GitHubProvider,
  type GitHubProviderConfig,
} from '../../auth/oauth/github.js';

/**
 * A GitHubProvider stub that always throws stateMismatch on callback — real
 * GitHub calls aren't made from a test, so we exercise the route-level state
 * validation path by providing a provider whose `authorizeUrl` / `handleCallback`
 * are predictable.
 */
class StubGitHub extends GitHubProvider {
  constructor(cfg: GitHubProviderConfig) {
    super(cfg);
  }
}

function buildApp(): Application {
  const db = createTestDb();
  const users = new UserRepository(db);
  const userAuth = new UserAuthRepository(db);
  const orgUsers = new OrgUserRepository(db);
  const userAuthTokens = new UserAuthTokenRepository(db);
  const apiKeys = new ApiKeyRepository(db);
  const auditLog = new AuditLogRepository(db);
  const sessions = new SessionService(userAuthTokens);
  const local = new LocalProvider(users);
  const audit = new AuditWriter(auditLog);
  const github = new StubGitHub({
    module: 'oauth_github',
    displayName: 'GitHub',
    clientId: 'cid',
    clientSecret: 'csec',
    redirectUri: 'https://app/callback',
    scopes: ['read:user'],
    allowSignup: true,
  });
  const app = express();
  app.use(express.json());
  app.use(
    '/api',
    createAuthRouter({
      users,
      userAuth,
      orgUsers,
      sessions,
      local,
      github,
      audit,
      defaultOrgId: 'org_main',
    }),
  );
  // Unused: the purpose of this harness is to test state-mismatch, which
  // GitHubProvider enforces before any network call.
  void apiKeys;
  return app;
}

describe('OAuth callback (integration)', () => {
  let app: Application;
  beforeAll(() => {
    // The callback route calls `resolveSecretKey()` before provider state
    // validation, so SECRET_KEY must be present for the handler to even run.
    // Production sets this via `bootstrap-secrets.ts`; tests must set it
    // explicitly since no global test setup exists.
    process.env['SECRET_KEY'] = 'a'.repeat(48);
  });
  beforeEach(() => {
    app = buildApp();
  });

  it('GET /api/login/github sets the state cookie and redirects', async () => {
    const res = await request(app).get('/api/login/github');
    expect(res.status).toBe(302);
    const sc = res.headers['set-cookie'];
    const cookies = Array.isArray(sc) ? sc : [sc];
    const stateCookie = cookies
      .filter(Boolean)
      .find((c) => c.includes('openobs_oauth_state_oauth_github'));
    expect(stateCookie).toBeTruthy();
    expect(res.headers['location']).toContain('client_id=cid');
    expect(res.headers['location']).toContain('state=');
  });

  it('callback without state cookie returns 400 (state mismatch)', async () => {
    const res = await request(app)
      .get('/api/login/github/callback?code=xxx&state=STATE_X');
    expect(res.status).toBe(400);
  });

  it('callback with mismatching state returns 400', async () => {
    const res = await request(app)
      .get('/api/login/github/callback?code=xxx&state=STATE_B')
      .set('Cookie', 'openobs_oauth_state_oauth_github=STATE_A');
    expect(res.status).toBe(400);
  });

  it('unknown provider returns 404', async () => {
    const res = await request(app)
      .get('/api/login/nope/callback?code=xxx&state=s');
    expect(res.status).toBe(404);
  });
});
