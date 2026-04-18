import { Router } from 'express';
import type { Router as ExpressRouter, Request, Response, NextFunction } from 'express';
import { createLogger } from '@agentic-obs/common';
import type { DashboardSseEvent } from '@agentic-obs/common';
import { authMiddleware } from '../middleware/auth.js';
import type { AuthenticatedRequest } from '../middleware/auth.js';
import { requirePermission } from '../middleware/rbac.js';
import { ChatService } from '../services/chat-service.js';
import type { ChatServiceDeps } from '../services/chat-service.js';

const log = createLogger('chat-router');

function sendSseEvent(res: Response, event: DashboardSseEvent): void {
  res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
}

/**
 * Handle a chat message via SSE — extracted as a standalone function
 * (same pattern as dashboard chat-handler.ts which works correctly).
 */
async function handleChatStream(
  req: AuthenticatedRequest,
  res: Response,
  message: string,
  sessionId: string | undefined,
  pageContext: { kind: string; id?: string } | undefined,
  deps: ChatServiceDeps,
): Promise<void> {
  // req.auth is guaranteed by authMiddleware above — if it's missing, the
  // middleware already short-circuited with 401 and we would not be here.
  if (!req.auth) {
    res.status(401).json({ message: 'authentication required' });
    return;
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  let closed = false;
  res.on('close', () => { closed = true; });

  const heartbeat = setInterval(() => {
    if (!closed) res.write(': heartbeat\n\n');
  }, 30_000);

  try {
    const service = new ChatService(deps);
    const result = await service.handleMessage(
      message,
      sessionId,
      (event) => { if (!closed) sendSseEvent(res, event); },
      req.auth,
      pageContext,
    );

    if (!closed) {
      sendSseEvent(res, {
        type: 'done',
        messageId: result.assistantMessageId,
        sessionId: result.sessionId,
        ...(result.navigate ? { navigate: result.navigate } : {}),
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
}

export function createChatRouter(deps: ChatServiceDeps): ExpressRouter {
  const router = Router();

  router.use(authMiddleware);

  // POST /chat — unified session-based chat endpoint (SSE streaming)
  router.post('/', requirePermission('dashboard:write'), async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const body = req.body as { message?: string; sessionId?: string; pageContext?: { kind: string; id?: string } };
      if (typeof body.message !== 'string' || body.message.trim() === '') {
        res.status(400).json({ code: 'INVALID_INPUT', message: 'message is required and must be a non-empty string' });
        return;
      }

      const message = body.message.trim();
      const sessionId = typeof body.sessionId === 'string' && body.sessionId.trim()
        ? body.sessionId.trim()
        : undefined;
      const pageContext = body.pageContext ?? undefined;

      await handleChatStream(req, res, message, sessionId, pageContext, deps);
    } catch (err) {
      next(err);
    }
  });

  // GET /chat/sessions — list recent chat sessions
  router.get('/sessions', requirePermission('dashboard:read'), async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!deps.chatSessionStore) {
        res.json({ sessions: [] });
        return;
      }
      const limit = Math.min(Number(req.query['limit']) || 50, 200);
      const sessions = await deps.chatSessionStore.findAll(limit);
      res.json({ sessions });
    } catch (err) {
      next(err);
    }
  });

  // GET /chat/sessions/:id/messages — get messages + persisted step events for
  // a session. The `events` array lets the web client rebuild the full chat
  // panel (agent activity blocks, tool calls, panel-added notices, etc.)
  // exactly as it looked during the live run.
  router.get('/sessions/:id/messages', requirePermission('dashboard:read'), async (req: Request, res: Response, next: NextFunction) => {
    try {
      const sessionId = req.params['id'] ?? '';
      if (!sessionId) {
        res.status(400).json({ code: 'INVALID_INPUT', message: 'session id is required' });
        return;
      }

      const [messages, events] = await Promise.all([
        deps.chatMessageStore
          ? deps.chatMessageStore.getMessages(sessionId)
          : deps.conversationStore.getMessages(sessionId),
        deps.chatEventStore ? deps.chatEventStore.listBySession(sessionId) : Promise.resolve([]),
      ]);
      res.json({ sessionId, messages, events });
    } catch (err) {
      next(err);
    }
  });

  // GET /chat/:sessionId — retrieve conversation history for a session (legacy)
  router.get('/:sessionId', requirePermission('dashboard:read'), async (req: Request, res: Response, next: NextFunction) => {
    try {
      const sessionId = req.params['sessionId'] ?? '';
      if (!sessionId) {
        res.status(400).json({ code: 'INVALID_INPUT', message: 'sessionId is required' });
        return;
      }

      if (deps.chatMessageStore) {
        const messages = await deps.chatMessageStore.getMessages(sessionId);
        res.json({ sessionId, messages });
      } else {
        const messages = await deps.conversationStore.getMessages(sessionId);
        res.json({ sessionId, messages });
      }
    } catch (err) {
      next(err);
    }
  });

  return router;
}
