import { Router } from 'express';
import { EvidenceStore } from '@agentic-obs/agent-core';
import { authMiddleware } from '../middleware/auth.js';
/**
 * Create the evidence router, optionally injecting an EvidenceStore.
 * Passing a custom store makes the routes fully testable without globals.
 */
export function createEvidenceRouter(store = new EvidenceStore()) {
    const router = Router({ mergeParams: true });
    // GET /investigation/:id/hypotheses/:hid/evidence
    // Returns all evidence items bound to a specific hypothesis.
    router.get('/investigations/:id/hypotheses/:hid/evidence', authMiddleware, (req, res, next) => {
        try {
            const { hid } = req.params;
            const items = store.getByHypothesis(hid);
            res.json(items);
        }
        catch (err) {
            next(err);
        }
    });
    // GET /evidence/:id
    // Returns single evidence item by ID (without raw query result).
    router.get('/evidence/:id', authMiddleware, (req, res, next) => {
        try {
            const evidence = store.get(req.params['id'] ?? '');
            if (!evidence) {
                res.status(404).json({ code: 'NOT_FOUND', message: 'Evidence not found' });
                return;
            }
            // Omit the raw `result` field - callers can fetch that
            // on result - result, ...summary } = evidence
            res.json(evidence);
        }
        catch (err) {
            next(err);
        }
    });
    /**
     * GET /evidence/:id/raw
     * Returns the original query string, language, and raw result for replay.
     */
    router.get('/evidence/:id/raw', authMiddleware, (req, res, next) => {
        try {
            const evidence = store.get(req.params['id'] ?? '');
            if (!evidence) {
                res.status(404).json({ code: 'NOT_FOUND', message: 'Evidence not found' });
                return;
            }
            res.json({
                id: evidence.id,
                query: evidence.query,
                queryLanguage: evidence.queryLanguage,
                result: evidence.result,
                timestamp: evidence.timestamp,
                reproducible: evidence.reproducible,
            });
        }
        catch (err) {
            next(err);
        }
    });
    return router;
}
// Shared singleton store for the running server
// Default router wired to the singleton store
export const evidenceStore = new EvidenceStore();
export const evidenceRouter = createEvidenceRouter(evidenceStore);
//# sourceMappingURL=evidence.js.map
