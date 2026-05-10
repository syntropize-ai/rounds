import { describe, expect, it } from 'vitest';
import type { Request, RequestHandler, Response } from 'express';
import { bootstrapAware } from './bootstrap-aware.js';
import type { SetupConfigService } from '../services/setup-config-service.js';

interface MockResponse extends Response {
  statusCodeValue?: number;
  body?: unknown;
}

function mockReq(method: string, path: string): Request {
  return {
    method,
    path,
    baseUrl: '',
  } as Request;
}

function mockRes(): MockResponse {
  const res: {
    locals: Record<string, unknown>;
    statusCodeValue?: number;
    body?: unknown;
    headersSent: boolean;
    status(code: number): typeof res;
    json(body: unknown): typeof res;
  } = {
    locals: {},
    status(code: number) {
      this.statusCodeValue = code;
      return this;
    },
    json(body: unknown) {
      this.body = body;
      return this;
    },
    headersSent: false,
  };
  return res as unknown as MockResponse;
}

function setupConfig(bootstrapped: boolean): SetupConfigService {
  return {
    isBootstrapped: async () => bootstrapped,
  } as unknown as SetupConfigService;
}

async function run(
  bootstrapped: boolean,
  method: string,
  path: string,
  allowlist = [{ method: 'POST', path: '/api/connectors' }],
): Promise<{ nextCalled: boolean; authCalled: boolean; res: MockResponse }> {
  let nextCalled = false;
  let authCalled = false;
  const authMiddleware: RequestHandler = (_req, _res, next) => {
    authCalled = true;
    next();
  };
  const mw = bootstrapAware({
    setupConfig: setupConfig(bootstrapped),
    authMiddleware,
    preBootstrapAllowlist: allowlist,
  });
  const res = mockRes();
  await new Promise<void>((resolve, reject) => {
    mw(mockReq(method, path), res, (err?: unknown) => {
      if (err) reject(err);
      nextCalled = true;
      resolve();
    });
    setTimeout(resolve, 0);
  });
  return { nextCalled, authCalled, res };
}

describe('bootstrapAware', () => {
  it('allows only explicit pre-bootstrap paths unauthenticated', async () => {
    const allowed = await run(false, 'POST', '/api/connectors');
    expect(allowed.nextCalled).toBe(true);
    expect(allowed.authCalled).toBe(false);
    expect(allowed.res.locals['allowBootstrapUnauthenticated']).toBe(true);

    const denied = await run(false, 'DELETE', '/api/connectors/ds_1');
    expect(denied.nextCalled).toBe(false);
    expect(denied.authCalled).toBe(false);
    expect(denied.res.statusCodeValue).toBe(401);
  });

  it('uses auth middleware after bootstrap', async () => {
    const result = await run(true, 'POST', '/api/connectors');
    expect(result.nextCalled).toBe(true);
    expect(result.authCalled).toBe(true);
    expect(result.res.locals['allowBootstrapUnauthenticated']).toBeUndefined();
  });
});
