import { Router } from 'express';
import type { Request, Response } from 'express';
import type { ApiError } from '@agentic-obs/common';
import { ac, ACTIONS } from '@agentic-obs/common';
import { authMiddleware } from '../middleware/auth.js';
import type { AuthenticatedRequest } from '../middleware/auth.js';
import { createRequirePermission } from '../middleware/require-permission.js';
import type { AccessControlSurface } from '../services/accesscontrol-holder.js';
import {
  type FeedEventType,
  type FeedSeverity,
  type FeedStatus,
  type FeedFeedback,
  type HypothesisFeedback,
  type ActionFeedback,
} from '@agentic-obs/data-layer';
import { initSse, sendSseEvent, sendSseKeepAlive } from './investigation/sse.js';
import type { IGatewayFeedStore } from '../repositories/types.js';
import { asyncHandler } from '../middleware/async-handler.js';

const VALID_FEED_TYPES: FeedEventType[] = [
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

export interface FeedRouterDeps {
  store: IGatewayFeedStore;
  /**
   * RBAC surface. Feed items are derived from investigation outcomes
   * (`investigation_complete`, `anomaly_detected`, etc.) so reads gate on
   * `investigations:read` and feedback writes gate on `investigations:write`
   * — Editor+ can tag verdicts; Viewer can only consume.
   */
  ac: AccessControlSurface;
}

function currentTenantId(req: Request): string {
  return (req as AuthenticatedRequest).auth!.orgId;
}

export function createFeedRouter(deps: FeedRouterDeps): Router {
  const store = deps.store;
  const router = Router();
  const requirePermission = createRequirePermission(deps.ac);
  const requireRead = requirePermission(() => ac.eval(ACTIONS.InvestigationsRead, 'investigations:*'));
  const requireWrite = requirePermission(() => ac.eval(ACTIONS.InvestigationsWrite, 'investigations:*'));

  // All feed routes require authentication
  router.use(authMiddleware);

  // GET /api/feed - paginated list with optional type/severity/status filters
  router.get('/', requireRead, asyncHandler(async (req: Request, res: Response): Promise<void> => {
    const page = parseInt(String(req.query['page'] ?? '1'), 10);
    const limit = parseInt(String(req.query['limit'] ?? '20'), 10);
    const type = req.query['type'] as FeedEventType | undefined;
    const severity = req.query['severity'] as FeedSeverity | undefined;
    const status = req.query['status'] as FeedStatus | undefined;

    if (!Number.isInteger(page) || page < 1) {
      const err: ApiError = { code: 'INVALID_PARAMS', message: 'page must be a positive integer' };
      res.status(400).json(err);
      return;
    }
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      const err: ApiError = { code: 'INVALID_PARAMS', message: 'limit must be between 1 and 100' };
      res.status(400).json(err);
      return;
    }
    if (type !== undefined && !VALID_FEED_TYPES.includes(type)) {
      const err: ApiError = { code: 'INVALID_PARAMS', message: `type must be one of: ${VALID_FEED_TYPES.join(', ')}` };
      res.status(400).json(err);
      return;
    }

    const validSeverities: FeedSeverity[] = ['low', 'medium', 'high', 'critical'];
    if (severity !== undefined && !validSeverities.includes(severity)) {
      const err: ApiError = { code: 'INVALID_PARAMS', message: `severity must be one of: ${validSeverities.join(', ')}` };
      res.status(400).json(err);
      return;
    }

    const validStatuses: FeedStatus[] = ['unread', 'read'];
    if (status !== undefined && !validStatuses.includes(status)) {
      const err: ApiError = { code: 'INVALID_PARAMS', message: `status must be one of: ${validStatuses.join(', ')}` };
      res.status(400).json(err);
      return;
    }

    res.json(await store.list({ page, limit, type, severity, status, tenantId: currentTenantId(req) }));
  }));

  // GET /api/feed/subscribe - SSE stream of new feed items
  router.get('/subscribe', requireRead, asyncHandler(async (req: Request, res: Response): Promise<void> => {
    const tenantId = currentTenantId(req);
    initSse(res);

    // Send current unread count as initial event
    sendSseEvent(res, { type: 'connected', data: { unreadCount: await store.getUnreadCount({ tenantId }) } });

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
    }, { tenantId });

    res.on('close', () => {
      clearInterval(keepAliveTimer);
      unsubscribe();
    });
  }));

  // GET /stats - aggregate feedback statistics (must be before /:id to avoid shadowing)
  router.get('/stats', requireRead, asyncHandler(async (req: Request, res: Response): Promise<void> => {
    res.json(await store.getStats({ tenantId: currentTenantId(req) }));
  }));

  // GET /api/feed/:id - single feed item
  router.get('/:id', requireRead, asyncHandler(async (req: Request, res: Response): Promise<void> => {
    const item = await store.get(req.params['id'] ?? '', { tenantId: currentTenantId(req) });
    if (!item) {
      const err: ApiError = { code: 'NOT_FOUND', message: 'Feed item not found' };
      res.status(404).json(err);
      return;
    }
    res.json(item);
  }));

  // POST /api/feed/:id/read - mark item as read
  router.post('/:id/read', requireWrite, asyncHandler(async (req: Request, res: Response): Promise<void> => {
    const item = await store.markRead(req.params['id'] ?? '', { tenantId: currentTenantId(req) });
    if (!item) {
      const err: ApiError = { code: 'NOT_FOUND', message: 'Feed item not found' };
      res.status(404).json(err);
      return;
    }
    res.json(item);
  }));

  // POST /api/feed/:id/feedback - record top-level feedback on a feed item
  router.post('/:id/feedback', requireWrite, asyncHandler(async (req: Request, res: Response): Promise<void> => {
    const id = req.params['id'] ?? '';
    const { feedback, comment } = req.body as { feedback?: unknown; comment?: unknown };

    const validFeedback: FeedFeedback[] = [
      'useful',
      'not_useful',
      'root_cause_correct',
      'root_cause_wrong',
      'partially_correct',
    ];

    if (!feedback || !validFeedback.includes(feedback as FeedFeedback)) {
      const err: ApiError = { code: 'INVALID_INPUT', message: `feedback must be one of: ${validFeedback.join(', ')}` };
      res.status(400).json(err);
      return;
    }

    if (comment !== undefined && typeof comment !== 'string') {
      const err: ApiError = { code: 'INVALID_INPUT', message: 'comment must be a string' };
      res.status(400).json(err);
      return;
    }

    const item = await store.addFeedback(
      id,
      feedback as FeedFeedback,
      typeof comment === 'string' ? comment : undefined,
      { tenantId: currentTenantId(req) },
    );
    if (!item) {
      const err: ApiError = { code: 'NOT_FOUND', message: 'Feed item not found' };
      res.status(404).json(err);
      return;
    }

    res.json(item);
  }));

  // POST /api/feed/:id/action-feedback - record per-action verdict
  router.post('/:id/action-feedback', requireWrite, asyncHandler(async (req: Request, res: Response): Promise<void> => {
    const id = req.params['id'] ?? '';
    const { actionId, helpful, comment } = req.body as {
      actionId?: unknown;
      helpful?: unknown;
      comment?: unknown;
    };

    if (typeof actionId !== 'string' || !actionId.trim()) {
      const err: ApiError = { code: 'INVALID_INPUT', message: 'actionId must be a non-empty string' };
      res.status(400).json(err);
      return;
    }
    if (typeof helpful !== 'boolean') {
      const err: ApiError = { code: 'INVALID_INPUT', message: 'helpful must be a boolean' };
      res.status(400).json(err);
      return;
    }
    if (comment !== undefined && typeof comment !== 'string') {
      const err: ApiError = { code: 'INVALID_INPUT', message: 'comment must be a string' };
      res.status(400).json(err);
      return;
    }

    const fb: ActionFeedback = {
      actionId,
      helpful,
      comment: typeof comment === 'string' ? comment : undefined,
    };

    const item = await store.addActionFeedback(id, fb, { tenantId: currentTenantId(req) });
    if (!item) {
      const err: ApiError = { code: 'NOT_FOUND', message: 'Feed item not found' };
      res.status(404).json(err);
      return;
    }

    res.json(item);
  }));

  // POST /api/feed/:id/follow-up - mark item as followed-up (user navigated to investigation)
  router.post('/:id/follow-up', requireWrite, asyncHandler(async (req: Request, res: Response): Promise<void> => {
    const item = await store.markFollowedUp(req.params['id'] ?? '', { tenantId: currentTenantId(req) });
    if (!item) {
      const err: ApiError = { code: 'NOT_FOUND', message: 'Feed item not found' };
      res.status(404).json(err);
      return;
    }
    res.json(item);
  }));

  // POST /api/feed/:id/hypothesis-feedback - record per-hypothesis verdict
  router.post('/:id/hypothesis-feedback', requireWrite, asyncHandler(async (req: Request, res: Response): Promise<void> => {
    const id = req.params['id'] ?? '';
    const { hypothesisId, verdict, comment } = req.body as {
      hypothesisId?: unknown;
      verdict?: unknown;
      comment?: unknown;
    };

    if (typeof hypothesisId !== 'string' || !hypothesisId.trim()) {
      const err: ApiError = { code: 'INVALID_INPUT', message: 'hypothesisId must be a non-empty string' };
      res.status(400).json(err);
      return;
    }

    const validVerdicts = ['correct', 'wrong'];
    if (typeof verdict !== 'string' || !validVerdicts.includes(verdict)) {
      const err: ApiError = { code: 'INVALID_INPUT', message: `verdict must be one of: ${validVerdicts.join(', ')}` };
      res.status(400).json(err);
      return;
    }

    if (comment !== undefined && typeof comment !== 'string') {
      const err: ApiError = { code: 'INVALID_INPUT', message: 'comment must be a string' };
      res.status(400).json(err);
      return;
    }

    const fb: HypothesisFeedback = {
      hypothesisId,
      verdict: verdict as 'correct' | 'wrong',
      comment: typeof comment === 'string' ? comment : undefined,
    };

    const item = await store.addHypothesisFeedback(id, fb, { tenantId: currentTenantId(req) });
    if (!item) {
      const err: ApiError = { code: 'NOT_FOUND', message: 'Feed item not found' };
      res.status(404).json(err);
      return;
    }

    res.json(item);
  }));

  return router;
}
