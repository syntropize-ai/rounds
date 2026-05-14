/**
 * /api/plans router. Phase 5 of `auto-remediation design notes`.
 *
 * Endpoints:
 *   GET    /api/plans?status=&investigationId=
 *   GET    /api/plans/:id
 *   POST   /api/plans/:id/approve { autoEdit?: boolean }
 *   POST   /api/plans/:id/reject
 *   POST   /api/plans/:id/cancel
 *   POST   /api/plans/:id/steps/:ordinal/retry
 *
 * RBAC:
 *   - GET endpoints      → plans:read
 *   - approve/reject/cancel/retry → plans:approve
 *   - autoEdit=true on approve → additionally requires plans:auto_edit
 *     (the caller without this grant gets 403; design-doc Q4 says
 *     auto-edit is opt-in per user/team).
 */

import { Router } from 'express';
import type { NextFunction, Request, Response } from 'express';
import type { ApiError } from '@agentic-obs/common';
import { ac, ACTIONS } from '@agentic-obs/common';
import type {
  IRemediationPlanRepository,
  RemediationPlanStatus,
} from '@agentic-obs/data-layer';
import type { ActionRisk, ActionSource, ConfirmationMode } from '@agentic-obs/common';
import { authMiddleware } from '../middleware/auth.js';

/**
 * Source × risk → confirmationMode. Mirrors guardrails' pickConfirmationMode
 * but inlined here to avoid pulling guardrails into api-gateway as a runtime
 * dep just for this read-only lookup. Keep in sync with
 * packages/guardrails/src/action-guard/action-guard.ts:pickConfirmationMode.
 */
function pickConfirmationMode(source: ActionSource, risk: ActionRisk): ConfirmationMode {
  if (source === 'background_agent') {
    return risk === 'high' || risk === 'critical' ? 'formal_approval' : 'none';
  }
  if (source === 'user_conversation' || source === 'manual_ui') {
    if (risk === 'critical' || risk === 'high') return 'strong_user_confirm';
    if (risk === 'medium') return 'user_confirm';
    return 'none';
  }
  return 'none';
}
import type { AuthenticatedRequest } from '../middleware/auth.js';
import { createRequirePermission } from '../middleware/require-permission.js';
import type { AccessControlSurface } from '../services/accesscontrol-holder.js';
import type { PlanExecutorService } from '../services/plan-executor-service.js';
import { extractPlanNamespaces } from '../services/plan-namespaces.js';

export interface PlansRouterDeps {
  plans: IRemediationPlanRepository;
  executor: PlanExecutorService;
  ac: AccessControlSurface;
}

const STATUSES: ReadonlySet<RemediationPlanStatus> = new Set([
  'draft',
  'pending_approval',
  'approved',
  'rejected',
  'executing',
  'completed',
  'failed',
  'expired',
  'cancelled',
]);

function parseStatus(raw: unknown): RemediationPlanStatus | RemediationPlanStatus[] | undefined {
  if (typeof raw === 'string' && STATUSES.has(raw as RemediationPlanStatus)) {
    return raw as RemediationPlanStatus;
  }
  if (Array.isArray(raw)) {
    const list = raw.filter((v): v is RemediationPlanStatus => STATUSES.has(v as RemediationPlanStatus));
    return list.length > 0 ? list : undefined;
  }
  return undefined;
}

export function createPlansRouter(deps: PlansRouterDeps): Router {
  const router = Router();
  const requirePermission = createRequirePermission(deps.ac);

  // ---------------------------------------------------------------------
  // GET /api/plans
  // ---------------------------------------------------------------------
  router.get(
    '/',
    authMiddleware,
    requirePermission(() => ac.eval(ACTIONS.PlansRead, 'plans:*')),
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
      try {
        const authReq = req as AuthenticatedRequest;
        const orgId = authReq.auth?.orgId;
        if (!orgId) {
          res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'org context required' } });
          return;
        }
        const status = parseStatus(req.query['status']);
        const investigationId = typeof req.query['investigationId'] === 'string'
          ? req.query['investigationId']
          : undefined;
        const list = await deps.plans.listByOrg(orgId, {
          ...(status ? { status } : {}),
          ...(investigationId ? { investigationId } : {}),
        });
        res.json(list);
      } catch (err) { next(err); }
    },
  );

  // ---------------------------------------------------------------------
  // GET /api/plans/:id
  // ---------------------------------------------------------------------
  router.get(
    '/:id',
    authMiddleware,
    requirePermission((req) => ac.eval(ACTIONS.PlansRead, `plans:uid:${req.params['id'] ?? ''}`)),
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
      try {
        const authReq = req as AuthenticatedRequest;
        const orgId = authReq.auth?.orgId;
        if (!orgId) {
          res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'org context required' } });
          return;
        }
        const plan = await deps.plans.findByIdInOrg(orgId, req.params['id'] ?? '');
        if (!plan) {
          const err: ApiError = { code: 'NOT_FOUND', message: 'plan not found' };
          res.status(404).json(err);
          return;
        }
        res.json(plan);
      } catch (err) { next(err); }
    },
  );

  // ---------------------------------------------------------------------
  // GET /api/plans/:id/confirmation
  //
  // Returns the (source, risk) → confirmationMode mapping for the plan in
  // the supplied context. Lets the UI render the right confirmation
  // surface (single-click vs. type-resource-name vs. formal approval)
  // WITHOUT having to first create an ApprovalRequest row.
  //
  // Query: ?source=user_conversation|background_agent|manual_ui|system
  //        ?risk=low|medium|high|critical
  // Defaults: source=background_agent, risk=high (existing plan default).
  // ---------------------------------------------------------------------
  router.get(
    '/:id/confirmation',
    authMiddleware,
    requirePermission((req) => ac.eval(ACTIONS.PlansRead, `plans:uid:${req.params['id'] ?? ''}`)),
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
      try {
        const authReq = req as AuthenticatedRequest;
        const orgId = authReq.auth?.orgId;
        if (!orgId) {
          res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'org context required' } });
          return;
        }
        const plan = await deps.plans.findByIdInOrg(orgId, req.params['id'] ?? '');
        if (!plan) {
          const err: ApiError = { code: 'NOT_FOUND', message: 'plan not found' };
          res.status(404).json(err);
          return;
        }
        const sources: ReadonlySet<ActionSource> = new Set([
          'user_conversation',
          'background_agent',
          'manual_ui',
          'system',
        ]);
        const risks: ReadonlySet<ActionRisk> = new Set(['low', 'medium', 'high', 'critical']);
        const sourceQ = String(req.query['source'] ?? 'background_agent');
        const riskQ = String(req.query['risk'] ?? 'high');
        const source: ActionSource = sources.has(sourceQ as ActionSource)
          ? (sourceQ as ActionSource)
          : 'background_agent';
        const risk: ActionRisk = risks.has(riskQ as ActionRisk)
          ? (riskQ as ActionRisk)
          : 'high';
        const confirmationMode = pickConfirmationMode(source, risk);
        // Caller-driven flow: when confirmationMode is user_confirm or
        // strong_user_confirm we explicitly tell the UI NOT to create an
        // ApprovalRequest — the confirm-in-chat path applies instead.
        res.json({
          source,
          risk,
          confirmationMode,
          requiresApprovalRequest: confirmationMode === 'formal_approval',
        });
      } catch (err) { next(err); }
    },
  );

  // ---------------------------------------------------------------------
  // POST /api/plans/:id/approve { autoEdit?: boolean }
  // ---------------------------------------------------------------------
  router.post(
    '/:id/approve',
    authMiddleware,
    requirePermission((req) => ac.eval(ACTIONS.PlansApprove, `plans:uid:${req.params['id'] ?? ''}`)),
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
      try {
        const authReq = req as AuthenticatedRequest;
        const auth = authReq.auth;
        if (!auth) {
          res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'authentication required' } });
          return;
        }
        const body = (req.body ?? {}) as { autoEdit?: boolean };
        const autoEdit = body.autoEdit === true;

        if (autoEdit) {
          // Two-layered auto-edit gate (design-doc §6 O2):
          //   1. Cluster-wide grant `plans:auto_edit` on `plans:*` short-
          //      circuits — this is the existing 'auto-edit anything' privilege.
          //   2. Otherwise, narrow to the namespaces this specific plan
          //      touches. Caller must hold `plans:auto_edit` on
          //      `plans:namespace:<ns>` for every namespace the plan
          //      writes to. A plan with any cluster-scoped step can NOT
          //      be narrowed and falls back to requiring `plans:*`.
          const plan = await deps.plans.findByIdInOrg(auth.orgId, req.params['id'] ?? '');
          if (!plan) {
            const err: ApiError = { code: 'NOT_FOUND', message: 'plan not found' };
            res.status(404).json(err);
            return;
          }
          const wildcard = await deps.ac.evaluate(
            auth,
            ac.eval(ACTIONS.PlansAutoEdit, 'plans:*'),
          );
          if (!wildcard) {
            const summary = extractPlanNamespaces(plan);
            if (summary.hasClusterScoped) {
              const err: ApiError = {
                code: 'FORBIDDEN',
                message: 'auto-edit on a plan with a cluster-scoped step requires plans:auto_edit on plans:* (cluster-wide grant)',
              };
              res.status(403).json(err);
              return;
            }
            for (const ns of summary.namespaces) {
              const ok = await deps.ac.evaluate(
                auth,
                ac.eval(ACTIONS.PlansAutoEdit, `plans:namespace:${ns}`),
              );
              if (!ok) {
                const err: ApiError = {
                  code: 'FORBIDDEN',
                  message: `auto-edit requires plans:auto_edit on plans:namespace:${ns}`,
                };
                res.status(403).json(err);
                return;
              }
            }
          }
        }

        const outcome = await deps.executor.approve(
          auth.orgId,
          req.params['id'] ?? '',
          autoEdit,
          auth,
        );
        const plan = await deps.plans.findByIdInOrg(auth.orgId, req.params['id'] ?? '');
        res.json({ outcome, plan });
      } catch (err) { next(err); }
    },
  );

  // ---------------------------------------------------------------------
  // POST /api/plans/:id/reject
  // ---------------------------------------------------------------------
  router.post(
    '/:id/reject',
    authMiddleware,
    requirePermission((req) => ac.eval(ACTIONS.PlansApprove, `plans:uid:${req.params['id'] ?? ''}`)),
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
      try {
        const authReq = req as AuthenticatedRequest;
        const auth = authReq.auth;
        if (!auth) {
          res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'authentication required' } });
          return;
        }
        const plan = await deps.executor.reject(
          auth.orgId,
          req.params['id'] ?? '',
          auth,
        );
        res.json(plan);
      } catch (err) { next(err); }
    },
  );

  // ---------------------------------------------------------------------
  // POST /api/plans/:id/cancel
  // ---------------------------------------------------------------------
  router.post(
    '/:id/cancel',
    authMiddleware,
    requirePermission((req) => ac.eval(ACTIONS.PlansApprove, `plans:uid:${req.params['id'] ?? ''}`)),
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
      try {
        const authReq = req as AuthenticatedRequest;
        const auth = authReq.auth;
        if (!auth) {
          res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'authentication required' } });
          return;
        }
        const plan = await deps.executor.cancel(
          auth.orgId,
          req.params['id'] ?? '',
          auth,
        );
        res.json(plan);
      } catch (err) { next(err); }
    },
  );

  // ---------------------------------------------------------------------
  // POST /api/plans/:id/steps/:ordinal/retry
  // ---------------------------------------------------------------------
  router.post(
    '/:id/steps/:ordinal/retry',
    authMiddleware,
    requirePermission((req) => ac.eval(ACTIONS.PlansApprove, `plans:uid:${req.params['id'] ?? ''}`)),
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
      try {
        const authReq = req as AuthenticatedRequest;
        const auth = authReq.auth;
        if (!auth) {
          res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'authentication required' } });
          return;
        }
        const ordinal = Number.parseInt(req.params['ordinal'] ?? '', 10);
        if (!Number.isInteger(ordinal) || ordinal < 0) {
          const err: ApiError = { code: 'BAD_REQUEST', message: 'ordinal must be a non-negative integer' };
          res.status(400).json(err);
          return;
        }
        const outcome = await deps.executor.retryStep(auth.orgId, req.params['id'] ?? '', ordinal);
        const plan = await deps.plans.findByIdInOrg(auth.orgId, req.params['id'] ?? '');
        res.json({ outcome, plan });
      } catch (err) { next(err); }
    },
  );

  return router;
}
