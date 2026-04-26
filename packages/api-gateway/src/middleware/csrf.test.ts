import { describe, expect, it } from 'vitest';
import type { NextFunction, Request, Response } from 'express';
import { SESSION_COOKIE_NAME } from '../auth/session-service.js';
import {
  CSRF_COOKIE_NAME,
  CSRF_HEADER_NAME,
  createCsrfMiddleware,
} from './csrf.js';

interface MockRes {
  _status: number;
  _body: unknown;
  _headers: Record<string, string | number | string[]>;
  status(code: number): MockRes;
  json(body: unknown): MockRes;
  setHeader(k: string, v: string | number | string[]): void;
  getHeader(k: string): string | number | string[] | undefined;
}

function mockRes(): MockRes {
  const headers: Record<string, string | number | string[]> = {};
  let status = 200;
  let body: unknown = undefined;
  const res: MockRes = {
    get _status() {
      return status;
    },
    get _body() {
      return body;
    },
    get _headers() {
      return headers;
    },
    status(code: number) {
      status = code;
      return res;
    },
    json(nextBody: unknown) {
      body = nextBody;
      return res;
    },
    setHeader(k: string, v: string | number | string[]) {
      headers[k] = v;
    },
    getHeader(k: string) {
      return headers[k];
    },
  };
  return res;
}

function mockReq(opts: {
  method: string;
  path?: string;
  cookie?: string;
  authorization?: string;
  xApiKey?: string;
  csrfHeader?: string;
}): Request {
  const headers: Record<string, string> = {};
  if (opts.cookie) headers['cookie'] = opts.cookie;
  if (opts.authorization) headers['authorization'] = opts.authorization;
  if (opts.xApiKey) headers['x-api-key'] = opts.xApiKey;
  if (opts.csrfHeader) headers[CSRF_HEADER_NAME] = opts.csrfHeader;
  return {
    method: opts.method,
    path: opts.path ?? '/api/widgets',
    headers,
  } as unknown as Request;
}

function runOnce(req: Request): { nextCalled: boolean; res: MockRes } {
  const mw = createCsrfMiddleware();
  const res = mockRes();
  let nextCalled = false;
  mw(req, res as unknown as Response, (() => {
    nextCalled = true;
  }) as NextFunction);
  return { nextCalled, res };
}

describe('createCsrfMiddleware', () => {
  it('mints a CSRF cookie and allows safe cookie-auth requests', () => {
    const { nextCalled, res } = runOnce(
      mockReq({
        method: 'GET',
        cookie: `${SESSION_COOKIE_NAME}=openobs_s_session`,
      }),
    );

    expect(nextCalled).toBe(true);
    expect(res._status).toBe(200);
    expect(res._headers['Set-Cookie']).toContain(`${CSRF_COOKIE_NAME}=`);
  });

  it('mints a CSRF cookie but rejects non-safe cookie-auth requests without one', () => {
    const { nextCalled, res } = runOnce(
      mockReq({
        method: 'POST',
        cookie: `${SESSION_COOKIE_NAME}=openobs_s_session`,
      }),
    );

    expect(nextCalled).toBe(false);
    expect(res._status).toBe(403);
    expect(res._body).toMatchObject({ error: { code: 'CSRF_FAILED' } });
    expect(res._headers['Set-Cookie']).toContain(`${CSRF_COOKIE_NAME}=`);
  });

  it('allows non-safe cookie-auth requests with a matching CSRF token', () => {
    const token = 'csrf-token';
    const { nextCalled, res } = runOnce(
      mockReq({
        method: 'PATCH',
        cookie: `${SESSION_COOKIE_NAME}=openobs_s_session; ${CSRF_COOKIE_NAME}=${token}`,
        csrfHeader: token,
      }),
    );

    expect(nextCalled).toBe(true);
    expect(res._status).toBe(200);
  });

  it('preserves bearer and x-api-key bypasses when no session cookie is present', () => {
    const bearer = runOnce(
      mockReq({ method: 'POST', authorization: 'Bearer openobs_token' }),
    );
    const apiKey = runOnce(
      mockReq({ method: 'DELETE', xApiKey: 'openobs_key' }),
    );

    expect(bearer.nextCalled).toBe(true);
    expect(bearer.res._headers['Set-Cookie']).toBeUndefined();
    expect(apiKey.nextCalled).toBe(true);
    expect(apiKey.res._headers['Set-Cookie']).toBeUndefined();
  });
});
