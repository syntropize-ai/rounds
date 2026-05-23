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
        const confirmation = getOpsCommandConfirmation(req.params['id'] ?? '');
        if (!confirmation || confirmation.orgId !== auth.orgId || confirmation.userId !== auth.userId) {
          res.status(404).json({ error: { code: 'NOT_FOUND', message: 'confirmation not found' } });
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
        resolveOpsCommandConfirmation(confirmation.id, 'executed');
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
        const confirmation = getOpsCommandConfirmation(req.params['id'] ?? '');
        if (!confirmation || confirmation.orgId !== auth.orgId || confirmation.userId !== auth.userId) {
          res.status(404).json({ error: { code: 'NOT_FOUND', message: 'confirmation not found' } });
          return;
        }
        if (confirmation.status !== 'pending') {
          res.status(409).json({ error: { code: 'CONFLICT', message: `confirmation is ${confirmation.status}` } });
          return;
        }
        resolveOpsCommandConfirmation(confirmation.id, 'rejected');
        res.json({ confirmation: getOpsCommandConfirmation(confirmation.id) });
      } catch (err) {
        next(err);
      }
    },
  );

  return router;
}
