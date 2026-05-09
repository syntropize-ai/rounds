/**
 * Tests for the plan confirmation endpoint that lets the UI render the
 * right confirmation surface (single-click vs. type-resource-name vs.
 * formal approval) WITHOUT first creating an ApprovalRequest row.
 *
 * Pins the requirement from optimize/extracted-from-images.md Task 06:
 * a `user_conversation` high-risk action MUST resolve to
 * `strong_user_confirm` and MUST NOT create an ApprovalRequest row.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import type { Evaluator, Identity, ResolvedPermission } from '@agentic-obs/common';
import { ACTIONS } from '@agentic-obs/common';
import type {
  IRemediationPlanRepository,
  RemediationPlan,
} from '@agentic-obs/data-layer';
import { createPlansRouter } from './plans.js';
import type { AccessControlSurface } from '../services/accesscontrol-holder.js';
import type { AuthenticatedRequest } from '../middleware/auth.js';
import { setAuthMiddleware } from '../middleware/auth.js';
import type { PlanExecutorService } from '../services/plan-executor-service.js';

function plan(overrides: Partial<RemediationPlan> = {}): RemediationPlan {
  return {
    id: 'plan-1',
    orgId: 'org_a',
    investigationId: 'inv-1',
    rescueForPlanId: null,
    summary: 'Scale payments-api',
    status: 'pending_approval',
    autoEdit: false,
    approvalRequestId: null,
    createdBy: 'agent',
    createdAt: '2026-01-01T00:00:00.000Z',
    expiresAt: '2026-01-02T00:00:00.000Z',
    resolvedAt: null,
    resolvedBy: null,
    steps: [],
    ...overrides,
  };
}

interface Harness {
  app: express.Express;
  approvalCreate: ReturnType<typeof vi.fn>;
}

function buildHarness(plans: RemediationPlan[], permissions: ResolvedPermission[]): Harness {
  const byId = new Map(plans.map((p) => [p.id, p]));
  const repo: IRemediationPlanRepository = {
    create: vi.fn(),
    findByIdInOrg: async (_orgId: string, id: string) => byId.get(id) ?? null,
    findById: async (id: string) => byId.get(id) ?? null,
    findByApprovalRequestId: async () => null,
    listByOrg: async () => plans,
    updatePlan: async () => null,
    updateStep: async () => null,
    delete: async () => false,
    expireStale: async () => 0,
  } as unknown as IRemediationPlanRepository;

  // Spy: any path that creates an approval request would touch this. The
  // confirmation endpoint MUST NOT call it. We don't have a direct
  // approval-store dependency in createPlansRouter, but the executor is
  // the only place that could escalate. Counting executor calls is an
  // adequate proxy.
  const approvalCreate = vi.fn();
  const executor = {
    approve: approvalCreate,
    reject: approvalCreate,
    cancel: approvalCreate,
    retryStep: approvalCreate,
  } as unknown as PlanExecutorService;

  const accessControl: AccessControlSurface = {
    getUserPermissions: async () => permissions,
    ensurePermissions: async () => permissions,
    filterByPermission: async (_id, items) => [...items],
    evaluate: async (_identity: Identity, evaluator: Evaluator) =>
      evaluator.evaluate(permissions),
  };

  setAuthMiddleware((req, _res, next) => {
    next();
    return undefined as unknown as void;
  });

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as AuthenticatedRequest).auth = {
      userId: 'u1',
      orgId: 'org_a',
      orgRole: 'Admin',
      isServerAdmin: false,
      authenticatedBy: 'session',
    };
    next();
  });
  app.use(
    '/api/plans',
    createPlansRouter({ plans: repo, executor, ac: accessControl }),
  );
  return { app, approvalCreate };
}

const READ_PERMS: ResolvedPermission[] = [
  { action: ACTIONS.PlansRead, scope: 'plans:*' },
];

describe('GET /api/plans/:id/confirmation', () => {
  beforeEach(() => vi.clearAllMocks());

  it('user_conversation + high risk → strong_user_confirm, NOT formal_approval', async () => {
    const { app, approvalCreate } = buildHarness([plan()], READ_PERMS);
    const res = await request(app)
      .get('/api/plans/plan-1/confirmation')
      .query({ source: 'user_conversation', risk: 'high' });
    expect(res.status).toBe(200);
    expect(res.body.confirmationMode).toBe('strong_user_confirm');
    expect(res.body.requiresApprovalRequest).toBe(false);
    // No executor / approval-create call.
    expect(approvalCreate).not.toHaveBeenCalled();
  });

  it('user_conversation + medium risk → user_confirm', async () => {
    const { app } = buildHarness([plan()], READ_PERMS);
    const res = await request(app)
      .get('/api/plans/plan-1/confirmation')
      .query({ source: 'user_conversation', risk: 'medium' });
    expect(res.status).toBe(200);
    expect(res.body.confirmationMode).toBe('user_confirm');
    expect(res.body.requiresApprovalRequest).toBe(false);
  });

  it('user_conversation + low risk → none', async () => {
    const { app } = buildHarness([plan()], READ_PERMS);
    const res = await request(app)
      .get('/api/plans/plan-1/confirmation')
      .query({ source: 'user_conversation', risk: 'low' });
    expect(res.status).toBe(200);
    expect(res.body.confirmationMode).toBe('none');
  });

  it('background_agent + high risk → formal_approval (requires ApprovalRequest)', async () => {
    const { app } = buildHarness([plan()], READ_PERMS);
    const res = await request(app)
      .get('/api/plans/plan-1/confirmation')
      .query({ source: 'background_agent', risk: 'high' });
    expect(res.status).toBe(200);
    expect(res.body.confirmationMode).toBe('formal_approval');
    expect(res.body.requiresApprovalRequest).toBe(true);
  });

  it('background_agent + low risk → none', async () => {
    const { app } = buildHarness([plan()], READ_PERMS);
    const res = await request(app)
      .get('/api/plans/plan-1/confirmation')
      .query({ source: 'background_agent', risk: 'low' });
    expect(res.status).toBe(200);
    expect(res.body.confirmationMode).toBe('none');
    expect(res.body.requiresApprovalRequest).toBe(false);
  });

  it('manual_ui + critical → strong_user_confirm', async () => {
    const { app } = buildHarness([plan()], READ_PERMS);
    const res = await request(app)
      .get('/api/plans/plan-1/confirmation')
      .query({ source: 'manual_ui', risk: 'critical' });
    expect(res.status).toBe(200);
    expect(res.body.confirmationMode).toBe('strong_user_confirm');
  });

  it('defaults: source=background_agent, risk=high → formal_approval', async () => {
    const { app } = buildHarness([plan()], READ_PERMS);
    const res = await request(app).get('/api/plans/plan-1/confirmation');
    expect(res.status).toBe(200);
    expect(res.body.source).toBe('background_agent');
    expect(res.body.risk).toBe('high');
    expect(res.body.confirmationMode).toBe('formal_approval');
  });

  it('unknown plan → 404', async () => {
    const { app } = buildHarness([], READ_PERMS);
    const res = await request(app).get('/api/plans/missing/confirmation');
    expect(res.status).toBe(404);
  });

  it('unknown source / risk values fall back to defaults (no 400)', async () => {
    const { app } = buildHarness([plan()], READ_PERMS);
    const res = await request(app)
      .get('/api/plans/plan-1/confirmation')
      .query({ source: 'totally_made_up', risk: 'whatever' });
    expect(res.status).toBe(200);
    expect(res.body.source).toBe('background_agent');
    expect(res.body.risk).toBe('high');
  });
});
