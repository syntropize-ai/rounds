/**
 * Per-row scope tests for the approval router.
 *
 * Pins approvals-multi-team-scope §3.3 / §3.4 acceptance:
 *   - List narrows by user's grants.
 *   - Detail/action routes deny → 404 (not 403) when no scope matches.
 *   - **Fail-closed invariant (R1)**: a connector-scoped grant for `dev-eks`
 *     does NOT broaden to `approvals:*` and so MUST NOT see `prod-eks` rows.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import type { Evaluator, Identity, ResolvedPermission } from '@agentic-obs/common';
import { ACTIONS, FIXED_ROLE_DEFINITIONS, findFixedRole, scopeCovers } from '@agentic-obs/common';
import type { ApprovalScopeFilter, IApprovalRequestRepository, IGatewayApprovalStore } from '@agentic-obs/data-layer';
import type { ApprovalRequest, ApprovalStatus } from '@agentic-obs/data-layer';
import { createApprovalRouter } from './approval.js';
import type { AccessControlSurface } from '../services/accesscontrol-holder.js';
import type { AuthenticatedRequest } from '../middleware/auth.js';
import { setAuthMiddleware } from '../middleware/auth.js';

function row(
  id: string,
  patch: Partial<ApprovalRequest> = {},
): ApprovalRequest {
  return {
    id,
    action: { type: 't', targetService: 's', params: {} },
    context: { requestedBy: 'u', reason: 'r' },
    status: 'pending' as ApprovalStatus,
    createdAt: '2026-01-01T00:00:00.000Z',
    expiresAt: '2026-01-02T00:00:00.000Z',
    opsConnectorId: null,
    targetNamespace: null,
    requesterTeamId: null,
    ...patch,
  };
}

function buildHarness(rows: ApprovalRequest[], permissions: ResolvedPermission[]) {
  const byId = new Map(rows.map((r) => [r.id, r]));

  const requests: IApprovalRequestRepository = {
    findById: async (id) => byId.get(id),
    submit: async () => { throw new Error('not used'); },
    listPending: async () => [...rows],
    list: async (_orgId, opts) => {
      const filter: ApprovalScopeFilter = opts?.scopeFilter ?? { kind: 'wildcard' };
      if (filter.kind === 'wildcard') return [...rows];
      return rows.filter((r) => {
        if (filter.uids?.has(r.id)) return true;
        if (r.opsConnectorId && filter.connectors?.has(r.opsConnectorId)) return true;
        if (
          r.opsConnectorId &&
          r.targetNamespace &&
          filter.nsPairs?.some((p) => p.connectorId === r.opsConnectorId && p.ns === r.targetNamespace)
        ) {
          return true;
        }
        if (r.requesterTeamId && filter.teams?.has(r.requesterTeamId)) return true;
        return false;
      });
    },
    approve: async (id) => byId.get(id),
    reject: async (id) => byId.get(id),
    override: async (id) => byId.get(id),
  };
  const approvals: IGatewayApprovalStore = {
    findById: requests.findById,
    listPending: requests.listPending,
    approve: requests.approve,
    reject: requests.reject,
    override: requests.override,
  };

  const accessControl: AccessControlSurface = {
    getUserPermissions: async () => permissions,
    ensurePermissions: async () => permissions,
    filterByPermission: async (_id, items) => [...items],
    evaluate: async (_identity: Identity, evaluator: Evaluator) =>
      evaluator.evaluate(permissions),
  };

  setAuthMiddleware((req, _res, next) => { next(); return undefined as unknown as void; });

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
  app.use('/api/approvals', createApprovalRouter({
    approvals,
    approvalRequests: requests,
    ac: accessControl,
  }));
  return { app };
}

const PROD_ROW = row('appr-prod', { opsConnectorId: 'prod-eks', targetNamespace: 'platform', requesterTeamId: 'platform' });
const DEV_ROW = row('appr-dev', { opsConnectorId: 'dev-eks', targetNamespace: 'apps', requesterTeamId: 'apps-team' });
const PROD_KSYS_ROW = row('appr-prod-ks', { opsConnectorId: 'prod-eks', targetNamespace: 'kube-system', requesterTeamId: 'platform' });
const NULL_ROW = row('appr-null'); // back-compat row, all NULL.

describe('/api/approvals — per-row scope', () => {
  beforeEach(() => vi.clearAllMocks());

  it('R1 fail-closed: connector:dev-eks user gets 404 on prod row (does not broaden to *)', async () => {
    const { app } = buildHarness([PROD_ROW], [
      { action: ACTIONS.ApprovalsRead, scope: 'approvals:connector:dev-eks' },
    ]);
    const res = await request(app).get(`/api/approvals/${PROD_ROW.id}`);
    expect(res.status).toBe(404);
  });

  it('approvals:* holder sees every row in list and detail', async () => {
    const all = [PROD_ROW, DEV_ROW, PROD_KSYS_ROW, NULL_ROW];
    const { app } = buildHarness(all, [
      { action: ACTIONS.ApprovalsRead, scope: 'approvals:*' },
    ]);
    const list = await request(app).get('/api/approvals');
    expect(list.status).toBe(200);
    expect(list.body.map((r: ApprovalRequest) => r.id).sort()).toEqual(all.map((r) => r.id).sort());

    for (const r of all) {
      const detail = await request(app).get(`/api/approvals/${r.id}`);
      expect(detail.status).toBe(200);
      expect(detail.body.id).toBe(r.id);
    }
  });

  it('connector:prod-eks: list returns only prod rows; dev row → 404 on detail', async () => {
    const { app } = buildHarness([PROD_ROW, DEV_ROW, PROD_KSYS_ROW], [
      { action: ACTIONS.ApprovalsRead, scope: 'approvals:connector:prod-eks' },
    ]);
    const list = await request(app).get('/api/approvals');
    expect(list.status).toBe(200);
    expect(list.body.map((r: ApprovalRequest) => r.id).sort()).toEqual([PROD_KSYS_ROW.id, PROD_ROW.id].sort());

    expect((await request(app).get(`/api/approvals/${PROD_ROW.id}`)).status).toBe(200);
    expect((await request(app).get(`/api/approvals/${DEV_ROW.id}`)).status).toBe(404);
  });

  it('namespace:prod-eks:platform: matches platform ns only', async () => {
    const { app } = buildHarness([PROD_ROW, PROD_KSYS_ROW], [
      { action: ACTIONS.ApprovalsRead, scope: 'approvals:namespace:prod-eks:platform' },
    ]);
    const list = await request(app).get('/api/approvals');
    expect(list.status).toBe(200);
    expect(list.body.map((r: ApprovalRequest) => r.id)).toEqual([PROD_ROW.id]);
    expect((await request(app).get(`/api/approvals/${PROD_KSYS_ROW.id}`)).status).toBe(404);
  });

  it('team:platform: matches platform-team rows only', async () => {
    const { app } = buildHarness([PROD_ROW, DEV_ROW, PROD_KSYS_ROW], [
      { action: ACTIONS.ApprovalsRead, scope: 'approvals:team:platform' },
    ]);
    const list = await request(app).get('/api/approvals');
    expect(list.status).toBe(200);
    expect(list.body.map((r: ApprovalRequest) => r.id).sort()).toEqual([PROD_KSYS_ROW.id, PROD_ROW.id].sort());
    expect((await request(app).get(`/api/approvals/${DEV_ROW.id}`)).status).toBe(404);
  });

  it('NULL row visibility: visible to *, hidden from connector-scoped grant', async () => {
    const wild = buildHarness([NULL_ROW], [
      { action: ACTIONS.ApprovalsRead, scope: 'approvals:*' },
    ]);
    expect((await request(wild.app).get(`/api/approvals/${NULL_ROW.id}`)).status).toBe(200);

    const narrow = buildHarness([NULL_ROW], [
      { action: ACTIONS.ApprovalsRead, scope: 'approvals:connector:prod-eks' },
    ]);
    expect((await request(narrow.app).get(`/api/approvals/${NULL_ROW.id}`)).status).toBe(404);
    const list = await request(narrow.app).get('/api/approvals');
    expect(list.body).toEqual([]);
  });

  it('approve: connector:prod-eks can approve prod, gets 404 on dev', async () => {
    const { app } = buildHarness([PROD_ROW, DEV_ROW], [
      { action: ACTIONS.ApprovalsRead, scope: 'approvals:connector:prod-eks' },
      { action: ACTIONS.ApprovalsApprove, scope: 'approvals:connector:prod-eks' },
    ]);
    expect((await request(app).post(`/api/approvals/${PROD_ROW.id}/approve`)).status).toBe(200);
    expect((await request(app).post(`/api/approvals/${DEV_ROW.id}/approve`)).status).toBe(404);
  });

  it('override: holder of approvals:override on approvals:* can override any row', async () => {
    const { app } = buildHarness([PROD_ROW, DEV_ROW], [
      { action: ACTIONS.ApprovalsRead, scope: 'approvals:*' },
      { action: ACTIONS.ApprovalsOverride, scope: 'approvals:*' },
    ]);
    expect((await request(app).post(`/api/approvals/${PROD_ROW.id}/override`)).status).toBe(200);
    expect((await request(app).post(`/api/approvals/${DEV_ROW.id}/override`)).status).toBe(200);
  });

  it('override: read-only user cannot override (404)', async () => {
    const { app } = buildHarness([PROD_ROW], [
      { action: ACTIONS.ApprovalsRead, scope: 'approvals:*' },
    ]);
    expect((await request(app).post(`/api/approvals/${PROD_ROW.id}/override`)).status).toBe(404);
  });
});

describe('FIXED_ROLE_DEFINITIONS — multi-team approval roles', () => {
  it('cluster_approver is registered with read+approve on approvals:connector:*', () => {
    const r = findFixedRole('fixed:approvals:cluster_approver');
    expect(r).toBeDefined();
    const perms = r!.permissions.map((p) => `${p.action} ${p.scope}`);
    expect(perms).toContain(`${ACTIONS.ApprovalsRead} approvals:connector:*`);
    expect(perms).toContain(`${ACTIONS.ApprovalsApprove} approvals:connector:*`);
    // And it covers a concrete connector after admin binding.
    expect(scopeCovers('approvals:connector:*', 'approvals:connector:prod-eks')).toBe(true);
  });

  it('namespace_approver is registered with read+approve on approvals:namespace:*:*', () => {
    const r = findFixedRole('fixed:approvals:namespace_approver');
    expect(r).toBeDefined();
    const perms = r!.permissions.map((p) => `${p.action} ${p.scope}`);
    expect(perms).toContain(`${ACTIONS.ApprovalsRead} approvals:namespace:*:*`);
    expect(perms).toContain(`${ACTIONS.ApprovalsApprove} approvals:namespace:*:*`);
  });

  it('team_viewer is registered with read on approvals:team:*', () => {
    const r = findFixedRole('fixed:approvals:team_viewer');
    expect(r).toBeDefined();
    expect(r!.permissions).toEqual([
      { action: ACTIONS.ApprovalsRead, scope: 'approvals:team:*' },
    ]);
  });

  it('all three roles appear in the catalog', () => {
    const names = FIXED_ROLE_DEFINITIONS.map((r) => r.name);
    expect(names).toContain('fixed:approvals:cluster_approver');
    expect(names).toContain('fixed:approvals:namespace_approver');
    expect(names).toContain('fixed:approvals:team_viewer');
  });
});
