import { describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import type { IGatewayFeedStore } from '@agentic-obs/data-layer';
import type { AccessControlSurface } from '../services/accesscontrol-holder.js';
import { errorHandler } from '../middleware/error-handler.js';
import { SESSION_COOKIE_NAME } from '../auth/session-service.js';
import { createFeedRouter } from './feed.js';
import { createAuthRouter, type AuthRouterDeps } from './auth.js';

vi.mock('../middleware/auth.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../middleware/auth.js')>()),
  authMiddleware: (req: any, _res: any, next: any) => {
    req.auth = {
      userId: 'user_1',
      orgId: 'org_a',
      orgRole: 'Admin',
      isServerAdmin: false,
      authenticatedBy: 'session',
    };
    next();
  },
}));

function makeApp(store: Partial<IGatewayFeedStore>) {
  const accessControl: AccessControlSurface = {
    evaluate: vi.fn(async () => true),
    getUserPermissions: vi.fn(async () => []),
    ensurePermissions: vi.fn(async () => []),
    filterByPermission: vi.fn(async (_identity, items) => [...items]),
  };

  const app = express();
  app.use(express.json());
  app.use('/feed', createFeedRouter({ store: store as IGatewayFeedStore, ac: accessControl }));
  app.use(errorHandler);
  return app;
}

describe('async route handlers surface rejections to the error middleware', () => {
  // Express 4 does not await handlers: without asyncHandler the rejection is
  // dropped, no response is ever written and this request hangs until the
  // test times out.
  it('answers 500 when the store a handler awaits rejects', async () => {
    const app = makeApp({
      getStats: vi.fn(async () => {
        throw new Error('stats backend exploded');
      }),
    });

    const res = await request(app).get('/feed/stats');

    expect(res.status).toBe(500);
    expect(res.body).toEqual({
      error: { code: 'INTERNAL_ERROR', message: 'Internal server error' },
    });
  }, 5000);

  it('leaves the resolving path untouched', async () => {
    const stats = { total: 0 };
    const app = makeApp({ getStats: vi.fn(async () => stats as any) });

    const res = await request(app).get('/feed/stats');

    expect(res.status).toBe(200);
    expect(res.body).toEqual(stats);
  }, 5000);

  // `logoutHandler` is defined once and registered by name on two routes, so
  // wrapping only inline function expressions leaves it uncovered.
  it('answers 500 when a handler registered by name rejects', async () => {
    const deps = {
      sessions: {
        lookupByToken: vi.fn(async () => {
          throw new Error('session store exploded');
        }),
      },
    } as unknown as AuthRouterDeps;

    const app = express();
    app.use(express.json());
    app.use('/api', createAuthRouter(deps));
    app.use(errorHandler);

    const res = await request(app)
      .post('/api/logout')
      .set('Cookie', `${SESSION_COOKIE_NAME}=some-token`);

    expect(res.status).toBe(500);
    expect(res.body).toEqual({
      error: { code: 'INTERNAL_ERROR', message: 'Internal server error' },
    });
  }, 5000);
});
