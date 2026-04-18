/**
 * T6.3 — auth middleware via ApiKeyService.
 *
 * Covers the SA-token / PAT branch of the middleware end-to-end: valid token,
 * revoked, expired, disabled principal, bad token, header precedence
 * (Authorization vs X-Api-Key).
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  ApiKeyRepository,
  AuditLogRepository,
  OrgUserRepository,
  UserAuthTokenRepository,
  UserRepository,
  createTestDb,
  seedDefaultOrg,
} from '@agentic-obs/data-layer';
import { SessionService } from '../auth/session-service.js';
import { AuditWriter } from '../auth/audit-writer.js';
import { ApiKeyService } from '../services/apikey-service.js';
import {
  createAuthMiddleware,
  type AuthenticatedRequest,
} from './auth.js';

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

interface Ctx {
  users: UserRepository;
  orgUsers: OrgUserRepository;
  apiKeys: ApiKeyRepository;
  svc: ApiKeyService;
  mw: ReturnType<typeof createAuthMiddleware>;
  saId: string;
  humanId: string;
}

async function build(): Promise<Ctx> {
  const db = createTestDb();
  await seedDefaultOrg(db);
  const users = new UserRepository(db);
  const orgUsers = new OrgUserRepository(db);
  const apiKeys = new ApiKeyRepository(db);
  const userAuthTokens = new UserAuthTokenRepository(db);
  const sessions = new SessionService(userAuthTokens);
  const audit = new AuditWriter(new AuditLogRepository(db));

  const sa = await users.create({
    email: 'sa@t.local',
    name: 'SA',
    login: 'sa-robot',
    orgId: 'org_main',
    isServiceAccount: true,
  });
  await orgUsers.create({ orgId: 'org_main', userId: sa.id, role: 'Viewer' });

  const human = await users.create({
    email: 'h@t.local',
    name: 'Human',
    login: 'human',
    orgId: 'org_main',
  });
  await orgUsers.create({ orgId: 'org_main', userId: human.id, role: 'Editor' });

  const svc = new ApiKeyService({ apiKeys, users, orgUsers, audit });
  const mw = createAuthMiddleware({
    sessions,
    users,
    orgUsers,
    apiKeys,
    apiKeyService: svc,
  });
  return { users, orgUsers, apiKeys, svc, mw, saId: sa.id, humanId: human.id };
}

async function runMw(
  mw: ReturnType<typeof createAuthMiddleware>,
  headers: Record<string, string>,
): Promise<{
  req: AuthenticatedRequest;
  res: ReturnType<typeof mockRes>;
  nextCalled: boolean;
}> {
  const req = { headers } as unknown as AuthenticatedRequest;
  const res = mockRes();
  let nextCalled = false;
  await mw(req, res, () => {
    nextCalled = true;
  });
  return { req, res, nextCalled };
}

describe('auth middleware — api_key branch via ApiKeyService', () => {
  let ctx: Ctx;
  beforeEach(async () => {
    ctx = await build();
  });

  it('accepts a valid SA token from Authorization: Bearer', async () => {
    const issued = await ctx.svc.issueServiceAccountToken(
      'org_main',
      ctx.saId,
      { name: 'a' },
    );
    const { req, nextCalled, res } = await runMw(ctx.mw, {
      authorization: `Bearer ${issued.key}`,
    });
    expect(res._status).toBe(200);
    expect(nextCalled).toBe(true);
    expect(req.auth?.userId).toBe(ctx.saId);
    expect(req.auth?.orgId).toBe('org_main');
    expect(req.auth?.orgRole).toBe('Viewer');
    expect(req.auth?.authenticatedBy).toBe('api_key');
    expect(req.auth?.serviceAccountId).toBe(ctx.saId);
  });

  it('accepts a valid PAT', async () => {
    const pat = await ctx.svc.issuePersonalAccessToken(
      'org_main',
      ctx.humanId,
      { name: 'p' },
    );
    const { req } = await runMw(ctx.mw, {
      authorization: `Bearer ${pat.key}`,
    });
    expect(req.auth?.userId).toBe(ctx.humanId);
    expect(req.auth?.serviceAccountId).toBeUndefined();
  });

  it('accepts X-Api-Key header', async () => {
    const issued = await ctx.svc.issueServiceAccountToken(
      'org_main',
      ctx.saId,
      { name: 'x' },
    );
    const { nextCalled } = await runMw(ctx.mw, {
      'x-api-key': issued.key,
    });
    expect(nextCalled).toBe(true);
  });

  it('401 for unknown token', async () => {
    const { res } = await runMw(ctx.mw, {
      authorization: 'Bearer openobs_sa_nope',
    });
    expect(res._status).toBe(401);
  });

  it('401 for revoked token', async () => {
    const issued = await ctx.svc.issueServiceAccountToken(
      'org_main',
      ctx.saId,
      { name: 'r' },
    );
    await ctx.svc.revoke('org_main', issued.id, ctx.humanId);
    const { res } = await runMw(ctx.mw, {
      authorization: `Bearer ${issued.key}`,
    });
    expect(res._status).toBe(401);
  });

  it('401 for expired token', async () => {
    const issued = await ctx.svc.issueServiceAccountToken(
      'org_main',
      ctx.saId,
      { name: 'e' },
    );
    await ctx.apiKeys.update(issued.id, {
      expires: new Date(Date.now() - 10_000).toISOString(),
    });
    const { res } = await runMw(ctx.mw, {
      authorization: `Bearer ${issued.key}`,
    });
    expect(res._status).toBe(401);
  });

  it('401 when SA is disabled', async () => {
    const issued = await ctx.svc.issueServiceAccountToken(
      'org_main',
      ctx.saId,
      { name: 'd' },
    );
    await ctx.users.update(ctx.saId, { isDisabled: true });
    const { res } = await runMw(ctx.mw, {
      authorization: `Bearer ${issued.key}`,
    });
    expect(res._status).toBe(401);
  });

  it('401 when no token provided and no cookie', async () => {
    const { res } = await runMw(ctx.mw, {});
    expect(res._status).toBe(401);
  });

  it('populates last_used_at on success', async () => {
    const issued = await ctx.svc.issueServiceAccountToken(
      'org_main',
      ctx.saId,
      { name: 'lu' },
    );
    expect((await ctx.apiKeys.findById(issued.id))?.lastUsedAt).toBeNull();
    await runMw(ctx.mw, { authorization: `Bearer ${issued.key}` });
    // touchLastUsed is fire-and-forget; wait a tick.
    await new Promise((r) => setTimeout(r, 20));
    expect((await ctx.apiKeys.findById(issued.id))?.lastUsedAt).not.toBeNull();
  });

  it('sessionId is undefined for api_key auth', async () => {
    const issued = await ctx.svc.issueServiceAccountToken(
      'org_main',
      ctx.saId,
      { name: 's' },
    );
    const { req } = await runMw(ctx.mw, {
      authorization: `Bearer ${issued.key}`,
    });
    expect(req.auth?.sessionId).toBeUndefined();
  });
});
