import { Router } from 'express';
import { authMiddleware } from '../middleware/auth.js';
import { requirePermission } from '../middleware/rbac.js';
import { initSse, sendSseEvent, sendSseKeepAlive } from './investigation/sse.js';
const VALID_FEED_TYPES = [
    'investigation_complete',
    'anomaly_detected',
    'change_impact',
    'incident_created',
    'proactive_investigation',
    'action_executed',
    'approval_requested',
    'approval_resolved',
    'verification_complete',
];
export function createFeedRouter(store) {
    const router = Router();
    // All feed routes require authentication and feed:read permission
    router.use(authMiddleware);
    router.use(requirePermission('feed:read'));
    // GET /api/feed - paginated list with optional type/severity/status filters
    router.get('/', async (req, res) => {
        const page = parseInt(String(req.query['page'] ?? '1'), 10);
        const limit = parseInt(String(req.query['limit'] ?? '20'), 10);
        const type = req.query['type'];
        const severity = req.query['severity'];
        const status = req.query['status'];
        if (!Number.isInteger(page) || page < 1) {
            const err = { code: 'INVALID_PARAMS', message: 'page must be a positive integer' };
            res.status(400).json(err);
            return;
        }
        if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
            const err = { code: 'INVALID_PARAMS', message: 'limit must be between 1 and 100' };
            res.status(400).json(err);
            return;
        }
        if (type !== undefined && !VALID_FEED_TYPES.includes(type)) {
            const err = { code: 'INVALID_PARAMS', message: `type must be one of: ${VALID_FEED_TYPES.join(', ')}` };
            res.status(400).json(err);
            return;
        }
        const validSeverities = ['low', 'medium', 'high', 'critical'];
        if (severity !== undefined && !validSeverities.includes(severity)) {
            const err = { code: 'INVALID_PARAMS', message: `severity must be one of: ${validSeverities.join(', ')}` };
            res.status(400).json(err);
            return;
        }
        const validStatuses = ['unread', 'read'];
        if (status !== undefined && !validStatuses.includes(status)) {
            const err = { code: 'INVALID_PARAMS', message: `status must be one of: ${validStatuses.join(', ')}` };
            res.status(400).json(err);
            return;
        }
        res.json(await store.list({ page, limit, type, severity, status }));
    });
    // GET /api/feed/subscribe - SSE stream of new feed items
    router.get('/subscribe', async (_req, res) => {
        initSse(res);
        // Send current unread count as initial event
        sendSseEvent(res, { type: 'connected', data: { unreadCount: await store.getUnreadCount() } });
        const keepAliveTimer = setInterval(() => {
            if (res.writableEnded) {
                clearInterval(keepAliveTimer);
                return;
            }
            sendSseKeepAlive(res);
        }, 15_000);
        const unsubscribe = store.subscribe((item) => {
            if (!res.writableEnded)
                sendSseEvent(res, { type: 'feed_item', data: item });
        });
        res.on('close', () => {
            clearInterval(keepAliveTimer);
            unsubscribe();
        });
    });
    // GET /stats - aggregate feedback statistics (must be before /:id to avoid shadowing)
    router.get('/stats', async (_req, res) => {
        res.json(await store.getStats());
    });
    // GET /api/feed/:id - single feed item
    router.get('/:id', async (req, res) => {
        const item = await store.get(req.params['id'] ?? '');
        if (!item) {
            const err = { code: 'NOT_FOUND', message: 'Feed item not found' };
            res.status(404).json(err);
            return;
        }
        res.json(item);
    });
    // POST /api/feed/:id/read - mark item as read
    router.post('/:id/read', async (req, res) => {
        const item = await store.markRead(req.params['id'] ?? '');
        if (!item) {
            const err = { code: 'NOT_FOUND', message: 'Feed item not found' };
            res.status(404).json(err);
            return;
        }
        res.json(item);
    });
    // POST /api/feed/:id/feedback - record top-level feedback on a feed item
    router.post('/:id/feedback', async (req, res) => {
        const id = req.params['id'] ?? '';
        const { feedback, comment } = req.body;
        const validFeedback = [
            'useful',
            'not_useful',
            'root_cause_correct',
            'root_cause_wrong',
            'partially_correct',
        ];
        if (!feedback || !validFeedback.includes(feedback)) {
            const err = { code: 'INVALID_INPUT', message: `feedback must be one of: ${validFeedback.join(', ')}` };
            res.status(400).json(err);
            return;
        }
        if (comment !== undefined && typeof comment !== 'string') {
            const err = { code: 'INVALID_INPUT', message: 'comment must be a string' };
            res.status(400).json(err);
            return;
        }
        const item = await store.addFeedback(id, feedback, typeof comment === 'string' ? comment : undefined);
        if (!item) {
            const err = { code: 'NOT_FOUND', message: 'Feed item not found' };
            res.status(404).json(err);
            return;
        }
        res.json(item);
    });
    // POST /api/feed/:id/action-feedback - record per-action verdict
    router.post('/:id/action-feedback', async (req, res) => {
        const id = req.params['id'] ?? '';
        const { actionId, helpful, comment } = req.body;
        if (typeof actionId !== 'string' || !actionId.trim()) {
            const err = { code: 'INVALID_INPUT', message: 'actionId must be a non-empty string' };
            res.status(400).json(err);
            return;
        }
        if (typeof helpful !== 'boolean') {
            const err = { code: 'INVALID_INPUT', message: 'helpful must be a boolean' };
            res.status(400).json(err);
            return;
        }
        if (comment !== undefined && typeof comment !== 'string') {
            const err = { code: 'INVALID_INPUT', message: 'comment must be a string' };
            res.status(400).json(err);
            return;
        }
        const fb = {
            actionId,
            helpful,
            comment: typeof comment === 'string' ? comment : undefined,
        };
        const item = await store.addActionFeedback(id, fb);
        if (!item) {
            const err = { code: 'NOT_FOUND', message: 'Feed item not found' };
            res.status(404).json(err);
            return;
        }
        res.json(item);
    });
    // POST /api/feed/:id/follow-up - mark item as followed-up (user navigated to investigation)
    router.post('/:id/follow-up', async (req, res) => {
        const item = await store.markFollowedUp(req.params['id'] ?? '');
        if (!item) {
            const err = { code: 'NOT_FOUND', message: 'Feed item not found' };
            res.status(404).json(err);
            return;
        }
        res.json(item);
    });
    // POST /api/feed/:id/hypothesis-feedback - record per-hypothesis verdict
    router.post('/:id/hypothesis-feedback', async (req, res) => {
        const id = req.params['id'] ?? '';
        const { hypothesisId, verdict, comment } = req.body;
        if (typeof hypothesisId !== 'string' || !hypothesisId.trim()) {
            const err = { code: 'INVALID_INPUT', message: 'hypothesisId must be a non-empty string' };
            res.status(400).json(err);
            return;
        }
        const validVerdicts = ['correct', 'wrong'];
        if (typeof verdict !== 'string' || !validVerdicts.includes(verdict)) {
            const err = { code: 'INVALID_INPUT', message: `verdict must be one of: ${validVerdicts.join(', ')}` };
            res.status(400).json(err);
            return;
        }
        if (comment !== undefined && typeof comment !== 'string') {
            const err = { code: 'INVALID_INPUT', message: 'comment must be a string' };
            res.status(400).json(err);
            return;
        }
        const fb = {
            hypothesisId,
            verdict: verdict,
            comment: typeof comment === 'string' ? comment : undefined,
        };
        const item = await store.addHypothesisFeedback(id, fb);
        if (!item) {
            const err = { code: 'NOT_FOUND', message: 'Feed item not found' };
            res.status(404).json(err);
            return;
        }
        res.json(item);
    });
    return router;
}
//# sourceMappingURL=feed.js.map