import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  ApiKeyRepository,
  OrgUserRepository,
  UserAuthTokenRepository,
  UserRepository,
  createTestDb,
} from '@agentic-obs/data-layer';
import { SessionService } from '../auth/session-service.js';
import {
  createAuthMiddleware,
  log as authLog,
  readCookie,
  type AuthenticatedRequest,
} from './auth.js';
import {
  SESSION_COOKIE_NAME,
} from '../auth/session-service.js';
import { createHash } from 'node:crypto';

function mockRes() {
  let status = 200;
  let jsonBody: unknown = undefined;
  const res = {
    status(code: number) {
      status = code;
      return res;
    },
    json(body: unknown) {
      jsonBody = body;
      return res;
    },
    setHeader() {
      /* noop */
    },
    get _status() {
      return status;
    },
    get _body() {
      return jsonBody;
    },
  };
  return res as unknown as import('express').Response & {
    _status: number;
    _body: unknown;
  };
}

describe('readCookie', () => {
  it('returns value for a present cookie', () => {
    expect(readCookie('a=1; b=2; c=3', 'b')).toBe('2');
  });
  it('handles no cookies', () => {
    expect(readCookie(undefined, 'x')).toBeNull();
  });
  it('returns null when cookie missing', () => {
    expect(readCookie('a=1', 'b')).toBeNull();
  });
  it('handles values with = signs', () => {
    expect(readCookie('t=a=b=c', 't')).toBe('a=b=c');
  });
});

describe('createAuthMiddleware', () => {
  let db: ReturnType<typeof createTestDb>;
  let users: UserRepository;
  let orgUsers: OrgUserRepository;
  let userAuthTokens: UserAuthTokenRepository;
  let apiKeys: ApiKeyRepository;
  let sessions: SessionService;
  let mw: ReturnType<typeof createAuthMiddleware>;

  beforeEach(async () => {
    db = createTestDb();
    users = new UserRepository(db);
    orgUsers = new OrgUserRepository(db);
    userAuthTokens = new UserAuthTokenRepository(db);
    apiKeys = new ApiKeyRepository(db);
    sessions = new SessionService(userAuthTokens);
    mw = createAuthMiddleware({ sessions, users, orgUsers, apiKeys });
  });

  it('returns 401 when no credentials provided', async () => {
    const req = { headers: {} } as unknown as AuthenticatedRequest;
    const res = mockRes();
    let called = false;
    await mw(req, res, () => {
      called = true;
    });
    expect(res._status).toBe(401);
    expect(called).toBe(false);
  });

  it('accepts a valid session cookie and sets req.auth', async () => {
    const user = await users.create({
      email: 'a@x.com',
      login: 'alice',
      name: 'A',
      orgId: 'org_main',
    });
    await orgUsers.create({ orgId: 'org_main', userId: user.id, role: 'Editor' });
    const { token } = await sessions.create(user.id, 'ua', '1.2.3.4');
    const req = {
      headers: { cookie: `${SESSION_COOKIE_NAME}=${token}` },
    } as unknown as AuthenticatedRequest;
    const res = mockRes();
    let called = false;
    await mw(req, res, () => {
      called = true;
    });
    expect(called).toBe(true);
    expect(req.auth?.userId).toBe(user.id);
    expect(req.auth?.orgRole).toBe('Editor');
    expect(req.auth?.authenticatedBy).toBe('session');
  });

  it('still authenticates when markSeen rejects and logs a structured warn', async () => {
    const user = await users.create({
      email: 'a@x.com',
      login: 'alice',
      name: 'A',
      orgId: 'org_main',
    });
    await orgUsers.create({ orgId: 'org_main', userId: user.id, role: 'Editor' });
    const { token, row } = await sessions.create(user.id, 'ua', '1.2.3.4');

    // Force markSeen to reject.
    const markErr = new Error('db unavailable');
    const markSeenSpy = vi
      .spyOn(sessions, 'markSeen')
      .mockRejectedValue(markErr);
    const warnSpy = vi.spyOn(authLog, 'warn').mockImplementation(() => {});

    try {
      const req = {
        headers: { cookie: `${SESSION_COOKIE_NAME}=${token}` },
      } as unknown as AuthenticatedRequest;
      const res = mockRes();
      let called = false;
      await mw(req, res, () => {
        called = true;
      });

      // Auth still succeeded.
      expect(called).toBe(true);
      expect(req.auth?.userId).toBe(user.id);
      expect(res._status).toBe(200);

      // markSeen rejection is fire-and-forget — wait one tick for the catch.
      await new Promise((r) => setImmediate(r));

      expect(warnSpy).toHaveBeenCalledTimes(1);
      const [fields, msg] = warnSpy.mock.calls[0]!;
      expect(fields).toMatchObject({
        sessionId: row.id,
        metric: 'session.markSeen.failed',
        err: 'db unavailable',
      });
      expect(msg).toContain('markSeen failed');
    } finally {
      warnSpy.mockRestore();
      markSeenSpy.mockRestore();
    }
  });

  it('returns 401 for an unknown session cookie', async () => {
    const req = {
      headers: { cookie: `${SESSION_COOKIE_NAME}=openobs_s_nope` },
    } as unknown as AuthenticatedRequest;
    const res = mockRes();
    await mw(req, res, () => null);
    expect(res._status).toBe(401);
  });

  it('returns 401 when session belongs to a disabled user', async () => {
    const user = await users.create({
      email: 'a@x.com',
      login: 'alice',
      name: 'A',
      orgId: 'org_main',
      isDisabled: true,
    });
    const { token } = await sessions.create(user.id, 'ua', '1.2.3.4');
    const req = {
      headers: { cookie: `${SESSION_COOKIE_NAME}=${token}` },
    } as unknown as AuthenticatedRequest;
    const res = mockRes();
    await mw(req, res, () => null);
    expect(res._status).toBe(401);
  });

  it('accepts an API key and sets req.auth.authenticatedBy=api_key', async () => {
    const key = 'openobs_' + 'a'.repeat(32);
    const hashed = createHash('sha256').update(key, 'utf8').digest('hex');
    const user = await users.create({
      email: 'sa@x.com',
      login: 'sa-bot',
      name: 'Bot',
      orgId: 'org_main',
      isServiceAccount: true,
    });
    await orgUsers.create({ orgId: 'org_main', userId: user.id, role: 'Admin' });
    await apiKeys.create({
      orgId: 'org_main',
      name: 'ci',
      key: hashed,
      role: 'Admin',
      serviceAccountId: user.id,
    });
    const req = {
      headers: { authorization: `Bearer ${key}` },
    } as unknown as AuthenticatedRequest;
    const res = mockRes();
    let called = false;
    await mw(req, res, () => {
      called = true;
    });
    expect(called).toBe(true);
    expect(req.auth?.authenticatedBy).toBe('api_key');
    expect(req.auth?.userId).toBe(user.id);
    expect(req.auth?.orgRole).toBe('Admin');
  });

  it('rejects an unknown API key', async () => {
    const req = {
      headers: { 'x-api-key': 'nope' },
    } as unknown as AuthenticatedRequest;
    const res = mockRes();
    await mw(req, res, () => null);
    expect(res._status).toBe(401);
  });

  it('refuses to boot without apiKeyService outside test mode', () => {
    const prev = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      expect(() =>
        createAuthMiddleware({ sessions, users, orgUsers, apiKeys }),
      ).toThrow(/apiKeyService is required outside test mode/);
    } finally {
      process.env.NODE_ENV = prev;
    }
  });

  it('rejects an expired API key', async () => {
    const key = 'openobs_' + 'b'.repeat(32);
    const hashed = createHash('sha256').update(key, 'utf8').digest('hex');
    await apiKeys.create({
      orgId: 'org_main',
      name: 'ci',
      key: hashed,
      role: 'Viewer',
      expires: '2000-01-01T00:00:00.000Z',
    });
    const req = {
      headers: { authorization: `Bearer ${key}` },
    } as unknown as AuthenticatedRequest;
    const res = mockRes();
    await mw(req, res, () => null);
    expect(res._status).toBe(401);
  });
});
