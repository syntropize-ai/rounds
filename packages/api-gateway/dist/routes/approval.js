import { Router } from 'express';
import { InMemoryApprovalRepository } from '@agentic-obs/data-layer';
import { authMiddleware } from '../middleware/auth.js';
import { requirePermission } from '../middleware/rbac.js';
const defaultRepo = new InMemoryApprovalRepository();
export function createApprovalRouter(repo = defaultRepo) {
    const router = Router();
    // GET /api/approvals - list pending approvals
    // Requires execution:read (operator, investigator, admin)
    router.get('/', authMiddleware, requirePermission('execution:read'), async (_req, res, next) => {
        try {
            res.json(await repo.listPending());
        }
        catch (err) {
            next(err);
        }
    });
    // GET /api/approvals/:id - get single approval request
    // Requires execution:read
    router.get('/:id', authMiddleware, requirePermission('execution:read'), async (req, res, next) => {
        try {
            const record = await repo.findById(req.params['id'] ?? '');
            if (!record) {
                const err = { code: 'NOT_FOUND', message: 'Approval request not found' };
                res.status(404).json(err);
                return;
            }
            res.json(record);
        }
        catch (err) {
            next(err);
        }
    });
    // POST /api/approvals/:id/approve - approve a pending request
    // Requires execution:approve (operator and admin only)
    router.post('/:id/approve', authMiddleware, requirePermission('execution:approve'), async (req, res, next) => {
        try {
            const authReq = req;
            const id = req.params['id'] ?? '';
            const resolvedBy = authReq.auth?.sub ?? 'unknown';
            const resolvedByRoles = authReq.auth?.roles ?? [];
            const updated = await repo.approve(id, resolvedBy, resolvedByRoles);
            if (!updated) {
                const existing = await repo.findById(id);
                if (!existing) {
                    const err = { code: 'NOT_FOUND', message: 'Approval request not found' };
                    res.status(404).json(err);
                    return;
                }
                const err = {
                    code: 'CONFLICT',
                    message: `Approval request is already ${existing.status} and cannot be approved`,
                };
                res.status(409).json(err);
                return;
            }
            res.json(updated);
        }
        catch (err) {
            next(err);
        }
    });
    // POST /api/approvals/:id/reject - reject a pending request
    // Requires execution:approve (operator and admin only)
    router.post('/:id/reject', authMiddleware, requirePermission('execution:approve'), async (req, res, next) => {
        try {
            const authReq = req;
            const id = req.params['id'] ?? '';
            const resolvedBy = authReq.auth?.sub ?? 'unknown';
            const resolvedByRoles = authReq.auth?.roles ?? [];
            const updated = await repo.reject(id, resolvedBy, resolvedByRoles);
            if (!updated) {
                const existing = await repo.findById(id);
                if (!existing) {
                    const err = { code: 'NOT_FOUND', message: 'Approval request not found' };
                    res.status(404).json(err);
                    return;
                }
                const err = {
                    code: 'CONFLICT',
                    message: `Approval request is already ${existing.status} and cannot be rejected`,
                };
                res.status(409).json(err);
                return;
            }
            res.json(updated);
        }
        catch (err) {
            next(err);
        }
    });
    // POST /api/approvals/:id/override - admin override: force-approve regardless of status
    // Requires execution:override (admin only via ui)
    router.post('/:id/override', authMiddleware, requirePermission('execution:override'), async (req, res, next) => {
        try {
            const authReq = req;
            const id = req.params['id'] ?? '';
            const resolvedBy = authReq.auth?.sub ?? 'unknown';
            const resolvedByRoles = authReq.auth?.roles ?? [];
            const updated = await repo.override(id, resolvedBy, resolvedByRoles);
            if (!updated) {
                const err = { code: 'NOT_FOUND', message: 'Approval request not found' };
                res.status(404).json(err);
                return;
            }
            res.json(updated);
        }
        catch (err) {
            next(err);
        }
    });
    return router;
}
export const approvalRouter = createApprovalRouter();
//# sourceMappingURL=approval.js.map
