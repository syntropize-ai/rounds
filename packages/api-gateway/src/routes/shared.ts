// Shared investigation access - public token-based endpoint

import { Router } from 'express';
import type { Request, Response, NextFunction } from 'express';
import { createLogger } from '@agentic-obs/common/logging';
import type { IGatewayShareStore, IGatewayInvestigationStore } from '@agentic-obs/data-layer';

type ResolvedShareLink = NonNullable<Awaited<ReturnType<IGatewayShareStore['findByToken']>>>;
import { authMiddleware } from '../middleware/auth.js';
import type { AuthenticatedRequest } from '../middleware/auth.js';

const log = createLogger('shared-route');

/**
 * Resolve a share token using the store's status-aware lookup when available,
 * falling back to the legacy `findByToken` (which can't distinguish expired
 * from not-found — those callers will continue to see a generic 404).
 */
async function resolveShare(
  shareRepo: IGatewayShareStore,
  token: string,
): Promise<
  | { kind: 'ok'; link: ResolvedShareLink }
  | { kind: 'expired' }
  | { kind: 'not_found' }
> {
  if (typeof shareRepo.findByTokenStatus === 'function') {
    return shareRepo.findByTokenStatus(token);
  }
  const link = await shareRepo.findByToken(token);
  return link ? { kind: 'ok', link } : { kind: 'not_found' };
}

export interface SharedRouterDeps {
  shareRepo: IGatewayShareStore;
  investigationStore: IGatewayInvestigationStore;
}

export function createSharedRouter(deps: SharedRouterDeps): Router {
  const shareRepo = deps.shareRepo;
  const investigationStore = deps.investigationStore;

  const router = Router();

  // GET /shared/:token - access a shared investigation (no auth required)
  router.get('/:token', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const token = req.params['token'] ?? '';
      const lookup = await resolveShare(shareRepo, token);
      if (lookup.kind === 'expired') {
        log.warn(
          { token },
          'shared-route: token expired — returning 410',
        );
        res.status(410).json({
          error: {
            code: 'EXPIRED',
            message: 'This share link has expired. Ask the owner to create a new one.',
          },
        });
        return;
      }
      if (lookup.kind === 'not_found') {
        res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Share link not found' } });
        return;
      }
      const link = lookup.link;

      const inv = await investigationStore.findById(link.investigationId);
      if (!inv) {
        res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Investigation not found' } });
        return;
      }

      const conclusion = await investigationStore.getConclusion(link.investigationId);

      res.json({
        permission: link.permission,
        investigation: {
          id: inv.id,
          intent: inv.intent,
          structuredIntent: inv.structuredIntent,
          plan: inv.plan,
          status: inv.status,
          hypotheses: inv.hypotheses,
          evidence: inv.evidence,
          symptoms: inv.symptoms,
          createdAt: inv.createdAt,
          updatedAt: inv.updatedAt,
        },
        conclusion: conclusion ?? null,
      });
    } catch (err) {
      next(err);
    }
  });

  // DELETE /shared/:token - revoke a share link (only the creator may revoke)
  router.delete('/:token', authMiddleware, async (req: Request, res: Response, next: NextFunction) => {
    try {
      const authReq = req as AuthenticatedRequest;
      const token = req.params['token'] ?? '';
      const lookup = await resolveShare(shareRepo, token);
      if (lookup.kind === 'expired') {
        // Expired link cannot be revoked — it's already effectively gone.
        res.status(410).json({
          error: { code: 'EXPIRED', message: 'This share link has expired and cannot be revoked.' },
        });
        return;
      }
      if (lookup.kind === 'not_found') {
        res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Share link not found' } });
        return;
      }
      const link = lookup.link;

      if (authReq.auth?.userId !== link.createdBy) {
        res.status(403).json({ error: { code: 'FORBIDDEN', message: 'Only the creator may revoke this share link' } });
        return;
      }

      await shareRepo.revoke(token);
      res.status(204).end();
    } catch (err) {
      next(err);
    }
  });

  return router;
}

