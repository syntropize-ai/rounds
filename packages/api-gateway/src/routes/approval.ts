import { Router } from 'express';
import type { Request, Response, NextFunction } from 'express';
import type { ApiError, ResolvedPermission } from '@agentic-obs/common';
import { ac, ACTIONS, approvalRowScopes, parseApprovalScope } from '@agentic-obs/common';
import { createLogger } from '@agentic-obs/common/logging';

const log = createLogger('approval-route');

/**
 * Structured warn before forwarding to Express's default error handler so a
 * caught failure carries `{ requestId, action, error }` into the operator
 * logs. The route still returns a 5xx via `next(err)` so the requestor sees
 * a definitive failure rather than a silent dead state.
 */
function logRouteError(
  action: string,
  err: unknown,
  context: { requestId?: string; userId?: string; orgId?: string },
): void {
  log.warn(
    {
      ...context,
      action,
      errClass: err instanceof Error ? err.constructor.name : typeof err,
      err: err instanceof Error ? err.message : String(err),
    },
    `approval-route: ${action} failed`,
  );
}
import type { IApprovalRequestRepository, IGatewayApprovalStore, ApprovalScopeFilter } from '@agentic-obs/data-layer';
import { authMiddleware } from '../middleware/auth.js';
import type { AuthenticatedRequest } from '../middleware/auth.js';
import type { AccessControlSurface } from '../services/accesscontrol-holder.js';

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
  /** Mutation surface (with onResolved pub/sub). */
  approvals: IGatewayApprovalStore;
  /**
   * Read/list surface. Required: `GET /` calls `list(orgId, { scopeFilter })`,
   * which `IGatewayApprovalStore` doesn't expose. Wired to the same underlying
   * repo as `approvals` (the EventEmittingApprovalRepository wraps this one
   * for the mutation pub/sub).
   */
  approvalRequests: IApprovalRequestRepository;
  /**
   * RBAC surface. `AccessControlSurface` is used (not the concrete service)
   * because this router is mounted outside the async auth IIFE in server.ts
   * — the holder forwards to the real service once it's built.
   */
  ac: AccessControlSurface;
}

/**
 * Build a per-row `ApprovalScopeFilter` from the user's `ApprovalsRead` grants.
 *
 * Returns:
 *   - `{ kind: 'wildcard' }` if any grant resolves to `approvals:*`.
 *   - Otherwise a `narrow` filter populated from the user's specific grants
 *     (uid / connector / namespace / team). Empty narrow set → list returns
 *     zero rows (T1.1's repo handles this).
 *
 * See approvals-multi-team-scope §3.3.
 */
function approvalsReadScopeFilter(
  permissions: readonly ResolvedPermission[],
): ApprovalScopeFilter {
  const reads = permissions.filter((p) => p.action === ACTIONS.ApprovalsRead);
  const uids = new Set<string>();
  const connectors = new Set<string>();
  const nsPairs: { connectorId: string; ns: string }[] = [];
  const teams = new Set<string>();
  for (const p of reads) {
    const parsed = parseApprovalScope(p.scope);
    if (!parsed) continue;
    if (parsed.kind === 'wildcard') return { kind: 'wildcard' };
    if (parsed.kind === 'uid') uids.add(parsed.id);
    else if (parsed.kind === 'connector') connectors.add(parsed.connectorId);
    else if (parsed.kind === 'namespace') nsPairs.push({ connectorId: parsed.connectorId, ns: parsed.ns });
    else if (parsed.kind === 'team') teams.add(parsed.teamId);
  }
  return { kind: 'narrow', uids, connectors, nsPairs, teams };
}

/**
 * True iff the user's permissions include `<action> on approvals:*`.
 *
 * Used to decide whether the wildcard scope is added to the per-row candidate
 * list — see fail-closed invariant in approvals-multi-team-scope §3.4 / R1.
 */
function holdsApprovalsWildcard(
  permissions: readonly ResolvedPermission[],
  action: string,
): boolean {
  return permissions.some(
    (p) =>
      p.action === action &&
      (p.scope === 'approvals:*' || p.scope === 'approvals:*:*' || p.scope === '*' || p.scope === ''),
  );
}

/**
 * Resolve whether the user can perform `action` on `row` per the per-row
 * scope rules. Builds the row's candidate scopes via `approvalRowScopes`, then
 * adds `approvals:*` ONLY if the user actually holds that wildcard grant.
 *
 * Critical: the naive "always include `approvals:*`" path is what the
 * fail-closed invariant prohibits. See approvals-multi-team-scope §3.4 / R1.
 */
async function evalRowAccess(
  acc: AccessControlSurface,
  identity: AuthenticatedRequest['auth'],
  permissions: readonly ResolvedPermission[],
  action: string,
  row: { id: string; opsConnectorId?: string | null; targetNamespace?: string | null; requesterTeamId?: string | null },
): Promise<boolean> {
  if (!identity) return false;
  const candidates = approvalRowScopes(row);
  if (holdsApprovalsWildcard(permissions, action)) {
    candidates.push('approvals:*');
  }
  const evaluator = ac.any(...candidates.map((s: string) => ac.eval(action, s)));
  return acc.evaluate(identity, evaluator);
}

export function createApprovalRouter(deps: ApprovalRouterDeps): Router {
  const router = Router();
  const repo = deps.approvals;
  const requests = deps.approvalRequests;
  const accessControl = deps.ac;

  function authOr401(
    req: Request,
    res: Response,
  ): AuthenticatedRequest['auth'] | null {
    const auth = (req as AuthenticatedRequest).auth;
    if (!auth) {
      res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'authentication required' } });
      return null;
    }
    return auth;
  }

  // GET /api/approvals — list approvals visible to the caller (per-row filter).
  router.get(
    '/',
    authMiddleware,
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
      try {
        const auth = authOr401(req, res);
        if (!auth) return;
        const perms = await accessControl.ensurePermissions(auth);
        const scopeFilter = approvalsReadScopeFilter(perms);
        const rows = await requests.list(auth.orgId, { scopeFilter });
        res.json(rows);
      } catch (err) {
        const auth = (req as AuthenticatedRequest).auth;
        logRouteError('list', err, { userId: auth?.userId, orgId: auth?.orgId });
        next(err);
      }
    },
  );

  // GET /api/approvals/:id — detail with per-row scope check. Deny → 404
  // (don't leak existence to a user who can't see this row).
  router.get(
    '/:id',
    authMiddleware,
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
      try {
        const auth = authOr401(req, res);
        if (!auth) return;
        const id = req.params['id'] ?? '';
        const record = await repo.findById(id);
        const notFound: ApiError = { code: 'NOT_FOUND', message: 'Approval request not found' };
        if (!record) {
          res.status(404).json(notFound);
          return;
        }
        const perms = await accessControl.ensurePermissions(auth);
        const allowed = await evalRowAccess(accessControl, auth, perms, ACTIONS.ApprovalsRead, record);
        if (!allowed) {
          res.status(404).json(notFound);
          return;
        }
        res.json(record);
      } catch (err) {
        const auth = (req as AuthenticatedRequest).auth;
        const requestId = req.params['id'];
        logRouteError('get', err, { requestId, userId: auth?.userId, orgId: auth?.orgId });
        next(err);
      }
    },
  );

  // POST /api/approvals/:id/approve — Editor+ via per-row `approvals:approve`.
  router.post(
    '/:id/approve',
    authMiddleware,
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
      try {
        const auth = authOr401(req, res);
        if (!auth) return;
        const id = req.params['id'] ?? '';
        const record = await repo.findById(id);
        const notFound: ApiError = { code: 'NOT_FOUND', message: 'Approval request not found' };
        if (!record) {
          res.status(404).json(notFound);
          return;
        }
        const perms = await accessControl.ensurePermissions(auth);
        const allowed = await evalRowAccess(accessControl, auth, perms, ACTIONS.ApprovalsApprove, record);
        if (!allowed) {
          res.status(404).json(notFound);
          return;
        }

        const resolvedBy = auth.userId ?? 'unknown';
        const resolvedByRoles = auth.isServerAdmin ? ['admin'] : [legacyOrgRole(auth.orgRole)];
        const updated = await repo.approve(id, resolvedBy, resolvedByRoles);
        if (!updated) {
          const err: ApiError = {
            code: 'CONFLICT',
            message: `Approval request is already ${record.status} and cannot be approved`,
          };
          res.status(409).json(err);
          return;
        }
        res.json(updated);
      } catch (err) {
        const auth = (req as AuthenticatedRequest).auth;
        const requestId = req.params['id'];
        logRouteError('approve', err, { requestId, userId: auth?.userId, orgId: auth?.orgId });
        next(err);
      }
    },
  );

  // POST /api/approvals/:id/reject — symmetric `approvals:approve` gate.
  router.post(
    '/:id/reject',
    authMiddleware,
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
      try {
        const auth = authOr401(req, res);
        if (!auth) return;
        const id = req.params['id'] ?? '';
        const record = await repo.findById(id);
        const notFound: ApiError = { code: 'NOT_FOUND', message: 'Approval request not found' };
        if (!record) {
          res.status(404).json(notFound);
          return;
        }
        const perms = await accessControl.ensurePermissions(auth);
        const allowed = await evalRowAccess(accessControl, auth, perms, ACTIONS.ApprovalsApprove, record);
        if (!allowed) {
          res.status(404).json(notFound);
          return;
        }

        const resolvedBy = auth.userId ?? 'unknown';
        const resolvedByRoles = auth.isServerAdmin ? ['admin'] : [legacyOrgRole(auth.orgRole)];
        const updated = await repo.reject(id, resolvedBy, resolvedByRoles);
        if (!updated) {
          const err: ApiError = {
            code: 'CONFLICT',
            message: `Approval request is already ${record.status} and cannot be rejected`,
          };
          res.status(409).json(err);
          return;
        }
        res.json(updated);
      } catch (err) {
        const auth = (req as AuthenticatedRequest).auth;
        const requestId = req.params['id'];
        logRouteError('reject', err, { requestId, userId: auth?.userId, orgId: auth?.orgId });
        next(err);
      }
    },
  );

  // POST /api/approvals/:id/override — Admin force-approve via `approvals:override`.
  router.post(
    '/:id/override',
    authMiddleware,
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
      try {
        const auth = authOr401(req, res);
        if (!auth) return;
        const id = req.params['id'] ?? '';
        const record = await repo.findById(id);
        const notFound: ApiError = { code: 'NOT_FOUND', message: 'Approval request not found' };
        if (!record) {
          res.status(404).json(notFound);
          return;
        }
        const perms = await accessControl.ensurePermissions(auth);
        const allowed = await evalRowAccess(accessControl, auth, perms, ACTIONS.ApprovalsOverride, record);
        if (!allowed) {
          res.status(404).json(notFound);
          return;
        }

        const resolvedBy = auth.userId ?? 'unknown';
        const resolvedByRoles = auth.isServerAdmin ? ['admin'] : [legacyOrgRole(auth.orgRole)];
        const updated = await repo.override(id, resolvedBy, resolvedByRoles);
        if (!updated) {
          res.status(404).json(notFound);
          return;
        }
        res.json(updated);
      } catch (err) {
        const auth = (req as AuthenticatedRequest).auth;
        const requestId = req.params['id'];
        logRouteError('override', err, { requestId, userId: auth?.userId, orgId: auth?.orgId });
        next(err);
      }
    },
  );

  return router;
}
