import { Router } from 'express';
import type { Request, Response, NextFunction } from 'express';
import type { ApiError } from '@agentic-obs/common';
import { ac, ACTIONS } from '@agentic-obs/common';
import type { IApprovalRequestRepository, IGatewayApprovalStore, IOpsConnectorRepository } from '@agentic-obs/data-layer';
import { authMiddleware } from '../middleware/auth.js';
import type { AuthenticatedRequest } from '../middleware/auth.js';
import { createRequirePermission } from '../middleware/require-permission.js';
import type { AccessControlSurface } from '../services/accesscontrol-holder.js';
import { OpsCommandRunnerService } from '../services/ops-command-runner-service.js';

/**
 * Stamp the caller's org role onto the approval record for audit. We keep the
 * legacy role-name vocabulary (`admin` / `operator` / `viewer`) on the stored
 * `resolvedByRoles` field because historical audit rows use those values —
 * changing the vocabulary would break the audit trail.
 */
function legacyOrgRole(role: string | undefined): string {
  if (role === 'Admin') return 'admin';
  if (role === 'Editor') return 'operator';
  return 'viewer';
}

export interface ApprovalRouterDeps {
  approvals: IGatewayApprovalStore;
  approvalRequests?: IApprovalRequestRepository;
  opsConnectors?: IOpsConnectorRepository;
  /**
   * RBAC surface. `AccessControlSurface` is used (not the concrete service)
   * because this router is mounted outside the async auth IIFE in server.ts
   * — the holder forwards to the real service once it's built.
   */
  ac: AccessControlSurface;
}

export function createApprovalRouter(deps: ApprovalRouterDeps): Router {
  const router = Router();
  const repo = deps.approvals;
  const requirePermission = createRequirePermission(deps.ac);

  // GET /api/approvals - list pending approvals
  router.get(
    '/',
    authMiddleware,
    requirePermission(() => ac.eval(ACTIONS.ApprovalsRead, 'approvals:*')),
    async (_req: Request, res: Response, next: NextFunction): Promise<void> => {
      try {
        res.json(await repo.listPending());
      } catch (err) {
        next(err);
      }
    },
  );

  // GET /api/approvals/:id - get single approval request
  router.get(
    '/:id',
    authMiddleware,
    requirePermission((req) =>
      ac.eval(ACTIONS.ApprovalsRead, `approvals:uid:${req.params['id'] ?? ''}`),
    ),
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
      try {
        const record = await repo.findById(req.params['id'] ?? '');
        if (!record) {
          const err: ApiError = { code: 'NOT_FOUND', message: 'Approval request not found' };
          res.status(404).json(err);
          return;
        }
        res.json(record);
      } catch (err) {
        next(err);
      }
    },
  );

  // POST /api/approvals/:id/approve - approve a pending request (Editor+ via
  // `approvals:approve`).
  router.post(
    '/:id/approve',
    authMiddleware,
    requirePermission((req) =>
      ac.eval(ACTIONS.ApprovalsApprove, `approvals:uid:${req.params['id'] ?? ''}`),
    ),
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
      try {
        const authReq = req as AuthenticatedRequest;
        const id = req.params['id'] ?? '';
        const resolvedBy = authReq.auth?.userId ?? 'unknown';
        const resolvedByRoles = authReq.auth?.isServerAdmin
          ? ['admin']
          : [legacyOrgRole(authReq.auth?.orgRole)];

        const updated = await repo.approve(id, resolvedBy, resolvedByRoles);
        if (!updated) {
          const existing = await repo.findById(id);
          if (!existing) {
            const err: ApiError = { code: 'NOT_FOUND', message: 'Approval request not found' };
            res.status(404).json(err);
            return;
          }

          const err: ApiError = {
            code: 'CONFLICT',
            message: `Approval request is already ${existing.status} and cannot be approved`,
          };
          res.status(409).json(err);
          return;
        }

        res.json(updated);
      } catch (err) {
        next(err);
      }
    },
  );

  // POST /api/approvals/:id/reject - reject a pending request (Editor+ via
  // `approvals:approve`; rejection is the symmetric side of approve).
  router.post(
    '/:id/reject',
    authMiddleware,
    requirePermission((req) =>
      ac.eval(ACTIONS.ApprovalsApprove, `approvals:uid:${req.params['id'] ?? ''}`),
    ),
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
      try {
        const authReq = req as AuthenticatedRequest;
        const id = req.params['id'] ?? '';
        const resolvedBy = authReq.auth?.userId ?? 'unknown';
        const resolvedByRoles = authReq.auth?.isServerAdmin
          ? ['admin']
          : [legacyOrgRole(authReq.auth?.orgRole)];

        const updated = await repo.reject(id, resolvedBy, resolvedByRoles);
        if (!updated) {
          const existing = await repo.findById(id);
          if (!existing) {
            const err: ApiError = { code: 'NOT_FOUND', message: 'Approval request not found' };
            res.status(404).json(err);
            return;
          }

          const err: ApiError = {
            code: 'CONFLICT',
            message: `Approval request is already ${existing.status} and cannot be rejected`,
          };
          res.status(409).json(err);
          return;
        }

        res.json(updated);
      } catch (err) {
        next(err);
      }
    },
  );

  // POST /api/approvals/:id/override - admin override; force-approve regardless
  // of status (Admin-only via `approvals:override`).
  router.post(
    '/:id/override',
    authMiddleware,
    requirePermission((req) =>
      ac.eval(ACTIONS.ApprovalsOverride, `approvals:uid:${req.params['id'] ?? ''}`),
    ),
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
      try {
        const authReq = req as AuthenticatedRequest;
        const id = req.params['id'] ?? '';
        const resolvedBy = authReq.auth?.userId ?? 'unknown';
        const resolvedByRoles = authReq.auth?.isServerAdmin
          ? ['admin']
          : [legacyOrgRole(authReq.auth?.orgRole)];

        const updated = await repo.override(id, resolvedBy, resolvedByRoles);
        if (!updated) {
          const err: ApiError = { code: 'NOT_FOUND', message: 'Approval request not found' };
          res.status(404).json(err);
          return;
        }

        res.json(updated);
      } catch (err) {
        next(err);
      }
    },
  );

  // POST /api/approvals/:id/execute - execute an already-approved operation.
  // This is intentionally narrow today: only `ops.run_command` approval
  // records are executable here, so Kubernetes fixes reuse the existing
  // approvals table instead of inventing a parallel Ops approval system.
  router.post(
    '/:id/execute',
    authMiddleware,
    requirePermission((req) =>
      ac.eval(ACTIONS.ApprovalsApprove, `approvals:uid:${req.params['id'] ?? ''}`),
    ),
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
      try {
        const authReq = req as AuthenticatedRequest;
        const auth = authReq.auth;
        if (!auth) {
          res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'authentication required' } });
          return;
        }
        if (!deps.approvalRequests || !deps.opsConnectors) {
          res.status(503).json({
            error: { code: 'NOT_CONFIGURED', message: 'approval execution is not configured' },
          });
          return;
        }
        const runner = new OpsCommandRunnerService({
          connectors: deps.opsConnectors,
          approvals: deps.approvalRequests,
        }, auth.orgId);
        const result = await runner.executeApprovedApproval(req.params['id'] ?? '', auth);
        const status = result.decision === 'executed' ? 200 : 400;
        res.status(status).json(result);
      } catch (err) {
        next(err);
      }
    },
  );

  return router;
}
