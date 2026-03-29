import { Router } from 'express';
import { SessionStore } from '@agentic-obs/data-layer';
import { authMiddleware } from '../middleware/auth.js';
export const sessionRouter = Router();
const store = new SessionStore();
sessionRouter.use(authMiddleware);
sessionRouter.post('/', (req, res, next) => {
    try {
        const body = req.body;
        if (!body.userId || typeof body.userId !== 'string') {
            res.status(400).json({ code: 'INVALID_INPUT', message: 'userId is required' });
            return;
        }
        const session = store.create(body.userId);
        res.status(201).json(session);
    }
    catch (err) {
        next(err);
    }
});
sessionRouter.get('/', (req, res, next) => {
    try {
        const { userId } = req.query;
        if (!userId || typeof userId !== 'string') {
            res.status(400).json({ code: 'INVALID_INPUT', message: 'userId query param is required' });
            return;
        }
        const sessions = store.listByUser(userId);
        res.json(sessions);
    }
    catch (err) {
        next(err);
    }
});
sessionRouter.get('/:id', (req, res, next) => {
    try {
        const session = store.get(req.params['id'] ?? '');
        if (!session) {
            res.status(404).json({ code: 'NOT_FOUND', message: 'Session not found' });
            return;
        }
        res.json(session);
    }
    catch (err) {
        next(err);
    }
});
sessionRouter.patch('/:id', (req, res, next) => {
    try {
        const id = req.params['id'] ?? '';
        const existing = store.get(id);
        if (!existing) {
            res.status(404).json({ code: 'NOT_FOUND', message: 'Session not found' });
            return;
        }
        const session = store.update(id, req.body);
        res.json(session);
    }
    catch (err) {
        next(err);
    }
});
sessionRouter.delete('/:id', (req, res, next) => {
    try {
        const id = req.params['id'] ?? '';
        const existing = store.get(id);
        if (!existing) {
            res.status(404).json({ code: 'NOT_FOUND', message: 'Session not found' });
            return;
        }
        store.delete(id);
        res.status(204).end();
    }
    catch (err) {
        next(err);
    }
});
//# sourceMappingURL=session.js.map
