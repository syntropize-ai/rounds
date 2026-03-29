// Shared investigation access - public (token-based) endpoint
import { Router } from 'express';
import { InMemoryShareRepository } from '@agentic-obs/data-layer';
import { defaultInvestigationStore } from './investigation/store.js';
import { authMiddleware } from '../middleware/auth.js';
export const defaultShareRepo = new InMemoryShareRepository();
export function createSharedRouter(deps = {}) {
    const shareRepo = deps.shareRepo ?? defaultShareRepo;
    const investigationStore = deps.investigationStore ?? defaultInvestigationStore;
    const router = Router();
    router.get('/:token', async (req, res, next) => {
        try {
            const token = req.params['token'] ?? '';
            const link = await shareRepo.findByToken(token);
            if (!link) {
                res.status(404).json({ code: 'NOT_FOUND', message: 'Share link not found or expired' });
                return;
            }
            const inv = await investigationStore.findById(link.investigationId);
            if (!inv) {
                res.status(404).json({ code: 'NOT_FOUND', message: 'Investigation not found' });
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
        }
        catch (err) {
            next(err);
        }
    });
    router.delete('/:token', authMiddleware, async (req, res, next) => {
        try {
            const authReq = req;
            const token = req.params['token'] ?? '';
            const link = await shareRepo.findByToken(token);
            if (!link) {
                res.status(404).json({ code: 'NOT_FOUND', message: 'Share link not found' });
                return;
            }
            if (authReq.auth?.sub !== link.createdBy) {
                res.status(403).json({ code: 'FORBIDDEN', message: 'Only the creator may revoke this share link' });
                return;
            }
            await shareRepo.revoke(token);
            res.status(204).end();
        }
        catch (err) {
            next(err);
        }
    });
    return router;
}
export const sharedRouter = createSharedRouter();
//# sourceMappingURL=shared.js.map
