import { Router } from 'express';
import type { Router as ExpressRouter, Request, Response, NextFunction } from 'express';
import { createLogger } from '@agentic-obs/common';
import type { DashboardSseEvent } from '@agentic-obs/common';
import { authMiddleware } from '../middleware/auth.js';
import { requirePermission } from '../middleware/rbac.js';
import { ChatService } from '../services/chat-service.js';
import type { ChatServiceDeps } from '../services/chat-service.js';

const log = createLogger('chat-router');

function sendSseEvent(res: Response, event: DashboardSseEvent): void {
  res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
}

export function createChatRouter(deps: ChatServiceDeps): ExpressRouter {
  const router = Router();

  router.use(authMiddleware);

  // POST /chat — unified session-based chat endpoint (SSE streaming)
  router.post('/', requirePermission('dashboard:write'), async (req: Request, res: Response, next: NextFunction) => {
    try {
      const body = req.body as { message?: string; sessionId?: string };
      if (typeof body.message !== 'string' || body.message.trim() === '') {
        res.status(400).json({ code: 'INVALID_INPUT', message: 'message is required and must be a non-empty string' });
        return;
      }

      const message = body.message.trim();
      const sessionId = typeof body.sessionId === 'string' && body.sessionId.trim()
        ? body.sessionId.trim()
        : undefined;

      // SSE setup
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });

      let closed = false;
      req.on('close', () => { closed = true; });

      const heartbeat = setInterval(() => {
        if (!closed) res.write(': heartbeat\n\n');
      }, 30_000);

      try {
        const service = new ChatService(deps);
        const result = await service.handleMessage(
          message,
          sessionId,
          (event) => { if (!closed) sendSseEvent(res, event); },
        );

        if (!closed) {
          sendSseEvent(res, {
            type: 'done',
            messageId: result.assistantMessageId,
            sessionId: result.sessionId,
          } as DashboardSseEvent & { sessionId: string });
        }
      } catch (err) {
        log.error({ err }, 'chat handler error');
        const errMsg = err instanceof Error ? err.message : 'Internal error';
        if (!closed) {
          res.write(`event: error\ndata: ${JSON.stringify({ type: 'error', message: errMsg })}\n\n`);
        }
      } finally {
        clearInterval(heartbeat);
        res.end();
      }
    } catch (err) {
      next(err);
    }
  });

  // GET /chat/:sessionId — retrieve conversation history for a session
  router.get('/:sessionId', requirePermission('dashboard:read'), async (req: Request, res: Response, next: NextFunction) => {
    try {
      const sessionId = req.params['sessionId'] ?? '';
      if (!sessionId) {
        res.status(400).json({ code: 'INVALID_INPUT', message: 'sessionId is required' });
        return;
      }

      const messages = await deps.conversationStore.getMessages(sessionId);
      res.json({ sessionId, messages });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
