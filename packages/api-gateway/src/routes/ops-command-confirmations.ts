import { Router } from 'express';
import type { Request, Response, NextFunction } from 'express';
import { ac, ACTIONS } from '@agentic-obs/common';
import type { IConnectorRepository } from '@agentic-obs/data-layer';
import { authMiddleware } from '../middleware/auth.js';
import type { AuthenticatedRequest } from '../middleware/auth.js';
import type { AccessControlSurface } from '../services/accesscontrol-holder.js';
import {
  KubectlOpsCommandRunner,
  getOpsCommandConfirmation,
  resolveOpsCommandConfirmation,
} from '../services/ops-command-runner.js';

export interface OpsCommandConfirmationsRouterDeps {
  connectors: IConnectorRepository;
  ac: AccessControlSurface;
}

function sendUnavailable(res: Response): void {
  res.status(410).json({
    error: {
      code: 'CONFIRMATION_UNAVAILABLE',
      message: 'This confirmation is no longer available. It may have expired or the API process was restarted.',
    },
  });
}

export function createOpsCommandConfirmationsRouter(
  deps: OpsCommandConfirmationsRouterDeps,
): Router {
  const router = Router();

  router.post(
    '/:id/execute',
    authMiddleware,
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
      try {
        const auth = (req as AuthenticatedRequest).auth;
        if (!auth) {
          res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'authentication required' } });
          return;
        }
        // Same-org scoping is enforced; the legacy userId-equality check is
        // intentionally NOT applied here. Background investigation agents
        // create confirmations under a service-account identity, so no
        // human could ever approve them under the old rule. RBAC below
        // (OpsCommandsRun on the connector OR InstanceConfigWrite) is the
        // real gate — anyone with that permission in the same org may
        // approve, and audit attribution records exactly who clicked.
        const confirmation = getOpsCommandConfirmation(req.params['id'] ?? '');
        if (!confirmation || confirmation.orgId !== auth.orgId) {
          sendUnavailable(res);
          return;
        }
        if (confirmation.status !== 'pending') {
          res.status(409).json({ error: { code: 'CONFLICT', message: `confirmation is ${confirmation.status}` } });
          return;
        }
        const allowed = await deps.ac.evaluate(
          auth,
          ac.any(
            ac.eval(ACTIONS.OpsCommandsRun, `connectors:id:${confirmation.connectorId}`),
            ac.eval(ACTIONS.InstanceConfigWrite),
          ),
        );
        if (!allowed) {
          res.status(403).json({ error: { code: 'FORBIDDEN', message: 'permission denied' } });
          return;
        }
        resolveOpsCommandConfirmation(confirmation.id, 'executed', { userId: auth.userId });
        res.json({ confirmation: getOpsCommandConfirmation(confirmation.id) });
      } catch (err) {
        next(err);
      }
    },
  );

  router.post(
    '/:id/reject',
    authMiddleware,
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
      try {
        const auth = (req as AuthenticatedRequest).auth;
        if (!auth) {
          res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'authentication required' } });
          return;
        }
        // Same-org scoping only — see the /execute handler for why the
        // userId-equality check is intentionally omitted.
        const confirmation = getOpsCommandConfirmation(req.params['id'] ?? '');
        if (!confirmation || confirmation.orgId !== auth.orgId) {
          sendUnavailable(res);
          return;
        }
        if (confirmation.status !== 'pending') {
          res.status(409).json({ error: { code: 'CONFLICT', message: `confirmation is ${confirmation.status}` } });
          return;
        }
        resolveOpsCommandConfirmation(confirmation.id, 'rejected', { userId: auth.userId });
        res.json({ confirmation: getOpsCommandConfirmation(confirmation.id) });
      } catch (err) {
        next(err);
      }
    },
  );

  return router;
}
