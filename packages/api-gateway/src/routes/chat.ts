import { Router } from 'express';
import type {
  Router as ExpressRouter,
  Request,
  Response,
  NextFunction,
} from 'express';
import { randomUUID } from 'node:crypto';
import { createLogger } from '@agentic-obs/server-utils/logging';
import type { ChatSessionContextResourceType, DashboardSseEvent } from '@agentic-obs/common';
import { ac, ACTIONS } from '@agentic-obs/common';
import { authMiddleware } from '../middleware/auth.js';
import type { AuthenticatedRequest } from '../middleware/auth.js';
import { createRequirePermission } from '../middleware/require-permission.js';
import { ChatService } from '../services/chat-service.js';
import {
  findOwnedChatSession,
  listOwnedChatSessions,
} from '../services/chat-service.js';
import type {
  ChatServiceDeps,
  ChatSessionOwnerScope,
} from '../services/chat-service.js';
import type { AgentRunRegistry } from '../services/agent-run-registry.js';
import { RunAlreadyActiveError } from '../services/agent-run-registry.js';
import type { SessionEventBus, SessionBusEvent } from '../services/session-event-bus.js';

const log = createLogger('chat-router');

type ChatPageContext = {
  kind: string;
  id?: string;
  timeRange?: string;
  clientTimezone?: string;
};

const chatSessionContextResourceTypes: readonly ChatSessionContextResourceType[] = [
  'dashboard',
  'dashboards',
  'investigation',
  'investigations',
  'alert',
  'plan',
  'evidence',
  'feed',
  'actions',
  'home',
];

const pumpingSessions = new Set<string>();

function sendSseEvent(res: Response, event: DashboardSseEvent): void {
  res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
}

async function publishSessionEvent(
  deps: ChatServiceDeps,
  sessionEventBus: SessionEventBus | undefined,
  sessionId: string,
  event: DashboardSseEvent,
): Promise<void> {
  if (deps.chatEventStore) {
    const saved = await deps.chatEventStore.appendNext({
      id: randomUUID(),
      sessionId,
      kind: event.type,
      payload: event as unknown as Record<string, unknown>,
      timestamp: new Date().toISOString(),
    });
    sessionEventBus?.publish(sessionId, saved.seq, event);
    return;
  }
  sessionEventBus?.publish(sessionId, 0, event);
}

async function enqueueChatMessage(
  deps: ChatServiceDeps,
  sessionEventBus: SessionEventBus | undefined,
  args: {
    sessionId: string;
    message: string;
    pageContext?: ChatPageContext;
    identity: NonNullable<AuthenticatedRequest['auth']>;
  },
): Promise<{ queueItemId: string; position: number; content: string }> {
  if (!deps.chatMessageQueueStore) {
    throw new Error('chat message queue store not configured');
  }
  const queued = await deps.chatMessageQueueStore.enqueue({
    sessionId: args.sessionId,
    orgId: args.identity.orgId,
    ownerUserId: args.identity.userId,
    content: args.message,
    pageContext: args.pageContext ?? null,
    identity: args.identity,
  });
  await publishSessionEvent(deps, sessionEventBus, args.sessionId, {
    type: 'message_queued',
    queueItemId: queued.id,
    sessionId: args.sessionId,
    position: queued.position,
    content: queued.content,
  });
  return { queueItemId: queued.id, position: queued.position, content: queued.content };
}

function respondQueued(
  res: Response,
  payload: { queueItemId: string; sessionId: string; position: number; content: string },
): void {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  sendSseEvent(res, {
    type: 'message_queued',
    queueItemId: payload.queueItemId,
    sessionId: payload.sessionId,
    position: payload.position,
    content: payload.content,
  });
  res.end();
}

function pumpSessionQueue(
  deps: ChatServiceDeps,
  runRegistry: AgentRunRegistry | undefined,
  sessionEventBus: SessionEventBus | undefined,
  sessionId: string,
): void {
  if (!deps.chatMessageQueueStore || !runRegistry || pumpingSessions.has(sessionId)) return;
  pumpingSessions.add(sessionId);
  void (async () => {
    try {
      while (!runRegistry.activeRunFor(sessionId)) {
        const item = await deps.chatMessageQueueStore!.claimNext(sessionId);
        if (!item) return;
        const run = runRegistry.start({
          sessionId,
          orgId: item.orgId,
          ownerUserId: item.ownerUserId,
        });
        await deps.chatMessageQueueStore!.markRunning(item.id, run.runId);
        await publishSessionEvent(deps, sessionEventBus, sessionId, {
          type: 'queued_message_started',
          queueItemId: item.id,
          sessionId,
          runId: run.runId,
          content: item.content,
        });
        const service = new ChatService(deps);
        let finalStatus: 'succeeded' | 'failed' | 'aborted' = 'succeeded';
        let errorMessage: string | undefined;
        try {
          await service.handleMessage(
            item.content,
            sessionId,
            () => undefined,
            item.identity,
            item.pageContext as ChatPageContext | undefined,
            run.controller.signal,
          );
          await deps.chatMessageQueueStore!.markSucceeded(item.id);
        } catch (err) {
          const error = err instanceof Error ? err : new Error(String(err));
          finalStatus = error.name === 'AbortError' ? 'aborted' : 'failed';
          errorMessage = error.message;
          await deps.chatMessageQueueStore!.markFailed(item.id, error.message);
          log.warn({ err, sessionId, queueItemId: item.id }, 'queued chat message failed');
        } finally {
          runRegistry.markComplete(run.runId, finalStatus, {
            ...(errorMessage ? { errorMessage } : {}),
          });
          runRegistry.releaseSession(run.runId);
        }
      }
    } finally {
      pumpingSessions.delete(sessionId);
      if (!runRegistry.activeRunFor(sessionId)) {
        const queued = await deps.chatMessageQueueStore!.listBySession(sessionId);
        if (queued.some((item) => item.status === 'queued')) {
          pumpSessionQueue(deps, runRegistry, sessionEventBus, sessionId);
        }
      }
    }
  })();
}

async function ensureSessionInOrg(
  deps: ChatServiceDeps,
  sessionId: string,
  scope: ChatSessionOwnerScope | undefined,
): Promise<boolean> {
  if (!scope || !deps.chatSessionStore) return false;
  const session = await findOwnedChatSession(
    deps.chatSessionStore,
    sessionId,
    scope,
  );
  return Boolean(session);
}

/**
 * Handle a chat message via SSE — extracted as a standalone function
 * (same pattern as dashboard chat-handler.ts which works correctly).
 *
 * Phase 1 detachment: the agent run is registered on the AgentRunRegistry
 * and its AbortController is owned by the registry, NOT bound to the HTTP
 * response. When the client disconnects we stop writing to the response
 * but DO NOT cancel the agent — it keeps running, persisting events to
 * the DB, and publishing to the SessionEventBus. Other tabs / a reopened
 * page can pick up the live tail via `GET /sessions/:id/events/stream`.
 *
 * Cancellation now goes through `POST /runs/:runId/cancel` explicitly.
 */
async function handleChatStream(
  req: AuthenticatedRequest,
  res: Response,
  message: string,
  sessionId: string | undefined,
  pageContext: ChatPageContext | undefined,
  deps: ChatServiceDeps,
  runRegistry: AgentRunRegistry | undefined,
  sessionEventBus: SessionEventBus | undefined,
): Promise<void> {
  // req.auth is guaranteed by authMiddleware above — if it's missing, the
  // middleware already short-circuited with 401 and we would not be here.
  if (!req.auth) {
    res.status(401).json({
      error: { code: 'UNAUTHORIZED', message: 'authentication required' },
    });
    return;
  }

  // Pre-allocate the sessionId so we can register the run + return the id
  // to the client BEFORE the agent does any work. ChatService is happy to
  // receive a fresh sessionId — it'll create the chat_sessions row on the
  // first event if one doesn't already exist.
  const resolvedSessionId = sessionId ?? randomUUID();

  // Pre-check the registry BEFORE writing SSE headers. Two cases to
  // handle (vs. the prior "any active run → 409" rule):
  //
  // 1. Active run is still 'running' → real conflict, 409 immediately.
  // 2. Active run is already markComplete'd but releaseSession hasn't
  //    fired yet (the orphan-protection window) → wait briefly. This
  //    closes the gap where a client posts a new message immediately
  //    after Stop and would otherwise see a spurious 409 just because
  //    the prior agent's drainPersistChain hasn't returned yet.
  if (runRegistry) {
    const existing = runRegistry.activeRunFor(resolvedSessionId);
    if (existing) {
      if (deps.chatMessageQueueStore) {
        const queued = await enqueueChatMessage(deps, sessionEventBus, {
          sessionId: resolvedSessionId,
          message,
          pageContext,
          identity: req.auth,
        });
        respondQueued(res, { ...queued, sessionId: resolvedSessionId });
        return;
      }
      // Genuine "still actively running, no cancel pending" → 409 fast so
      // the client knows the session is in use. But if the controller's
      // already aborted (a cancel just landed, the agent hasn't unwound
      // yet) OR status flipped past 'running' (markComplete fired,
      // releaseSession imminent), fall into the wait loop — the user
      // just typed a follow-up message right after Stop / right after a
      // run started canceling, and the registry will free up shortly.
      const looksTerminating =
        existing.status !== 'running' || existing.controller.signal.aborted;
      if (!looksTerminating) {
        res.status(409).json({
          error: {
            code: 'RUN_ALREADY_ACTIVE',
            message: `session ${resolvedSessionId} already has an active run; cancel it or wait for it to finish`,
          },
        });
        return;
      }
      // Wait up to 10s for releaseSession to fire. The agent task usually
      // finishes within milliseconds once the abort signal fires, but a
      // tool call mid-network-roundtrip can take several seconds to
      // unwind; 10s comfortably covers that without approaching typical
      // HTTP idle timeouts (60s+). On still-stuck we 409 RUN_DRAINING
      // so a frontend can choose to auto-retry rather than show error.
      const deadline = Date.now() + 10_000;
      while (
        runRegistry.activeRunFor(resolvedSessionId) &&
        Date.now() < deadline
      ) {
        await new Promise((r) => setTimeout(r, 50));
      }
      if (runRegistry.activeRunFor(resolvedSessionId)) {
        res.status(409).json({
          error: {
            code: 'RUN_DRAINING',
            message: `prior run on session ${resolvedSessionId} hasn't released yet — retry shortly`,
          },
        });
        return;
      }
    }
  }

  if (deps.chatMessageQueueStore && sessionId) {
    const queuedItems = await deps.chatMessageQueueStore.listBySession(resolvedSessionId);
    if (queuedItems.some((item) => item.status === 'queued')) {
      const queued = await enqueueChatMessage(deps, sessionEventBus, {
        sessionId: resolvedSessionId,
        message,
        pageContext,
        identity: req.auth,
      });
      respondQueued(res, { ...queued, sessionId: resolvedSessionId });
      pumpSessionQueue(deps, runRegistry, sessionEventBus, resolvedSessionId);
      return;
    }
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  let closed = false;
  res.on('close', () => {
    // Client disconnect no longer cancels the agent. We just stop writing
    // to the dead socket. The run continues to completion in the
    // background; its events keep persisting to the DB and publishing to
    // the bus, so a reconnecting client can pick up via the events stream
    // endpoint. Explicit cancel via /runs/:id/cancel is the only path
    // that stops a run now.
    closed = true;
  });
  // Last-resort: any 'error' on the response with no handler crashes the
  // node process. The detached-agent architecture makes write-after-end
  // races thinkable; the inner sendEvent callback already wraps writes
  // and catches that specific code, but if anything else (heartbeat,
  // run_started, done) trips it, we don't want the gateway to exit.
  res.on('error', () => {
    closed = true;
  });

  // Registry is wired in every production code path (see domain-routes);
  // tests that omit it lose the cancel mechanism but the agent still runs
  // synchronously inside the request handler, so they're unaffected.
  let runRecord: { runId: string; controller: AbortController } | undefined;
  if (runRegistry && req.auth) {
    try {
      const r = runRegistry.start({
        sessionId: resolvedSessionId,
        orgId: req.auth.orgId,
        ownerUserId: req.auth.userId,
      });
      runRecord = { runId: r.runId, controller: r.controller };
    } catch (err) {
      if (err instanceof RunAlreadyActiveError) {
        res.write(
          `event: error\ndata: ${JSON.stringify({ type: 'error', message: err.message, code: 'RUN_ALREADY_ACTIVE' })}\n\n`,
        );
        res.end();
        return;
      }
      throw err;
    }
  }
  // When no registry is wired we run with an unaborted signal — the
  // legacy "request-bound cancellation" path is gone (it was the source
  // of the original bug). Tests that need cancellation must wire a
  // registry.
  const abortSignal = runRecord?.controller.signal ?? new AbortController().signal;

  // Tell the client which run they just started so they can subscribe to
  // /events/stream and call /sessions/:id/cancel-active (or /runs/:id/cancel
  // for runId-precise targeting). Includes sessionId because new chats
  // start without one client-side and need it to wire the Stop button.
  if (runRecord) {
    sendSseEvent(res, {
      type: 'run_started',
      runId: runRecord.runId,
      sessionId: resolvedSessionId,
    } as unknown as DashboardSseEvent);
  }

  const heartbeat = setInterval(() => {
    if (!closed) res.write(': heartbeat\n\n');
  }, 30_000);

  let agentError: Error | null = null;
  try {
    const service = new ChatService(deps);
    // Race the agent's awaited handleMessage against the abort signal so
    // a non-cooperative tool (one that doesn't honor signal mid-call)
    // still unblocks the response. The orphan agent task may keep
    // running in the background — Node can't forcibly kill an async
    // function. We keep the session reserved in the registry (via
    // markComplete-but-not-releaseSession) until the agent promise
    // actually settles, so a new POST can't race the orphan and
    // collide on the per-session seq counter inside ChatService
    // (re-review finding: orphan agent + session re-acquisition).
    const agentPromise = service.handleMessage(
      message,
      resolvedSessionId,
      (event) => {
        // Belt-and-suspenders: the !closed check covers the normal case,
        // but a write that races res.end (orphan agent continues firing
        // after the route's finally block runs) would crash the process
        // via ERR_STREAM_WRITE_AFTER_END → unhandled 'error' on res.
        // Swallow that specific failure mode here — the event is still
        // persisted + bus-published by the chat-service wrapper.
        if (closed) return;
        try {
          sendSseEvent(res, event);
        } catch (err) {
          if (
            err instanceof Error &&
            (err as { code?: string }).code === 'ERR_STREAM_WRITE_AFTER_END'
          ) {
            closed = true; // catch up the flag so future calls short-circuit
            return;
          }
          throw err;
        }
      },
      req.auth,
      pageContext,
      abortSignal,
    );
    if (runRecord && runRegistry) {
      const runId = runRecord.runId;
      // Settle-or-throw, doesn't matter — we just need to know the
      // background work finished so the session index can be freed.
      // `.finally` survives both success and rejection.
      agentPromise.catch(() => undefined).finally(() => {
        runRegistry.releaseSession(runId);
        pumpSessionQueue(deps, runRegistry, sessionEventBus, resolvedSessionId);
      });
    }
    const abortPromise = new Promise<never>((_, reject) => {
      if (abortSignal.aborted) {
        reject(abortError());
        return;
      }
      abortSignal.addEventListener(
        'abort',
        () => reject(abortError()),
        { once: true },
      );
    });
    await Promise.race([agentPromise, abortPromise]);
  } catch (err) {
    agentError = err instanceof Error ? err : new Error(String(err));
  }

  // Mark complete BEFORE emitting `done` (review finding #2). The frontend
  // can re-POST immediately after `done`; if markComplete runs in finally
  // (after res.end queues), the next POST sees activeRunFor() === this
  // record and 409s. Moving the mark earlier closes the window.
  if (runRecord && runRegistry) {
    const finalStatus = agentError
      ? agentError.name === 'AbortError'
        ? 'aborted'
        : 'failed'
      : 'succeeded';
    runRegistry.markComplete(runRecord.runId, finalStatus, {
      ...(agentError ? { errorMessage: agentError.message } : {}),
    });
  }

  try {
    if (agentError) {
      if (agentError.name === 'AbortError') {
        log.info(
          {
            sessionId,
            runId: runRecord?.runId,
            userId: req.auth?.userId,
            messageLength: message.length,
          },
          'chat run aborted by explicit cancel',
        );
      } else {
        log.error(
          { err: agentError, runId: runRecord?.runId },
          'chat handler error',
        );
        if (!closed) {
          res.write(
            `event: error\ndata: ${JSON.stringify({ type: 'error', message: agentError.message })}\n\n`,
          );
        }
      }
    }
    // No route-level `done` emission — chat-service.handleMessage emits
    // the terminal `done` exactly once via wrappedSendEvent before
    // returning, so it lands on both the in-request stream AND the
    // persisted event trace / live bus. Duplicating it here would write
    // a second `done` to the HTTP response.
  } finally {
    clearInterval(heartbeat);
    // CRITICAL: set closed BEFORE res.end() so any sendEvent callback
    // the orphan agent fires in the next tick — its closure still holds
    // a reference to `res` — sees `closed=true` and skips res.write().
    // Without this, `res.on('close')` fires asynchronously after end,
    // leaving a window where the orphan can write to an ended stream
    // → ERR_STREAM_WRITE_AFTER_END → unhandled 'error' on res → process
    // exits.
    if (!closed) {
      closed = true;
      res.end();
    }
  }
}

function abortError(): Error {
  const e = new Error('aborted');
  e.name = 'AbortError';
  return e;
}

export interface CreateChatRouterOptions {
  /** Detached-run registry. When omitted, runs are tied to the request
   *  signal (legacy behavior). Mount in production for the
   *  client-disconnect-doesn't-kill-the-agent behavior. */
  runRegistry?: AgentRunRegistry;
  /** Live-tail bus. Required for `/sessions/:id/events/stream` to actually
   *  stream new events; without it that endpoint only replays history. */
  sessionEventBus?: SessionEventBus;
}

export function createChatRouter(
  deps: ChatServiceDeps,
  opts: CreateChatRouterOptions = {},
): ExpressRouter {
  const router = Router();
  const requirePermission = createRequirePermission(deps.accessControl);
  const { runRegistry, sessionEventBus } = opts;

  router.use(authMiddleware);

  // POST /chat — unified session-based chat endpoint (SSE streaming)
  router.post(
    '/',
    requirePermission(() => ac.eval(ACTIONS.ChatUse)),
    async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
      try {
        const body = req.body as {
          message?: string;
          sessionId?: string;
          pageContext?: ChatPageContext;
        };
        if (typeof body.message !== 'string' || body.message.trim() === '') {
          res.status(400).json({
            error: {
              code: 'INVALID_INPUT',
              message: 'message is required and must be a non-empty string',
            },
          });
          return;
        }

        const message = body.message.trim();
        const sessionId =
          typeof body.sessionId === 'string' && body.sessionId.trim()
            ? body.sessionId.trim()
            : undefined;
        const pageContext = body.pageContext ?? undefined;
        const ownerScope = req.auth
          ? { orgId: req.auth.orgId, ownerUserId: req.auth.userId }
          : undefined;
        if (
          sessionId &&
          !(await ensureSessionInOrg(deps, sessionId, ownerScope))
        ) {
          res.status(404).json({
            error: { code: 'NOT_FOUND', message: 'Chat session not found' },
          });
          return;
        }

        await handleChatStream(req, res, message, sessionId, pageContext, deps, runRegistry, sessionEventBus);
      } catch (err) {
        next(err);
      }
    },
  );

  // GET /chat/sessions — list recent chat sessions
  router.get(
    '/sessions',
    requirePermission(() => ac.eval(ACTIONS.ChatUse)),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        if (!deps.chatSessionStore) {
          res.json({ sessions: [] });
          return;
        }
        const auth = (req as AuthenticatedRequest).auth;
        if (!auth) {
          res.status(401).json({
            error: {
              code: 'UNAUTHORIZED',
              message: 'authentication required',
            },
          });
          return;
        }
        const limit = Math.min(Number(req.query['limit']) || 50, 200);
        const scope = { orgId: auth.orgId, ownerUserId: auth.userId };
        const sessions = await listOwnedChatSessions(
          deps.chatSessionStore,
          limit,
          scope,
        );
        res.json({ sessions });
      } catch (err) {
        next(err);
      }
    },
  );

  // DELETE /chat/sessions/:id — remove an idle owned chat session from history.
  router.delete(
    '/sessions/:id',
    requirePermission(() => ac.eval(ACTIONS.ChatUse)),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        if (!deps.chatSessionStore) {
          res.status(501).json({ error: { code: 'NOT_IMPLEMENTED', message: 'chat sessions not configured' } });
          return;
        }
        const auth = (req as AuthenticatedRequest).auth;
        if (!auth) {
          res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'authentication required' } });
          return;
        }
        const sessionId = req.params['id'] ?? '';
        if (!sessionId) {
          res.status(400).json({ error: { code: 'INVALID_INPUT', message: 'session id required' } });
          return;
        }
        const active = runRegistry?.activeRunFor(sessionId);
        if (active?.status === 'running') {
          res.status(409).json({
            error: { code: 'RUN_ACTIVE', message: 'Cannot delete a conversation while it is running.' },
          });
          return;
        }
        const scope = { orgId: auth.orgId, ownerUserId: auth.userId };
        const deleted = await deps.chatSessionStore.delete(sessionId, scope);
        if (!deleted) {
          res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Chat session not found' } });
          return;
        }
        res.status(204).end();
      } catch (err) {
        next(err);
      }
    },
  );

  // GET /chat/sessions/by-context?resourceType=dashboard&resourceId=X&limit=1
  // Used when opening a dashboard / investigation / alert page — returns the
  // most-recent owned chat session whose chat_session_contexts row matches,
  // so the page auto-resumes that conversation instead of starting blank.
  router.get(
    '/sessions/by-context',
    requirePermission(() => ac.eval(ACTIONS.ChatUse)),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        if (!deps.chatSessionContextStore || !deps.chatSessionStore) {
          res.json({ sessions: [] });
          return;
        }
        const auth = (req as AuthenticatedRequest).auth;
        if (!auth) {
          res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'authentication required' } });
          return;
        }
        const resourceType = String(req.query['resourceType'] ?? '');
        const resourceId = String(req.query['resourceId'] ?? '');
        if (!resourceType || !resourceId) {
          res.status(400).json({ error: { code: 'VALIDATION', message: 'resourceType and resourceId required' } });
          return;
        }
        if (!chatSessionContextResourceTypes.includes(resourceType as ChatSessionContextResourceType)) {
          res.status(400).json({ error: { code: 'VALIDATION', message: `resourceType must be one of ${chatSessionContextResourceTypes.join(',')}` } });
          return;
        }
        const limit = Math.min(Number(req.query['limit']) || 1, 50);
        const rows = await deps.chatSessionContextStore.listByResource(
          {
            orgId: auth.orgId,
            ownerUserId: auth.userId,
            resourceType: resourceType as ChatSessionContextResourceType,
            resourceId,
          },
          limit,
        );
        // Hydrate the session metadata so the frontend can show titles too.
        const sessions = [];
        for (const row of rows) {
          const session = await deps.chatSessionStore.findById(row.sessionId, {
            orgId: auth.orgId,
            ownerUserId: auth.userId,
          });
          if (session) sessions.push(session);
        }
        res.json({ sessions });
      } catch (err) {
        next(err);
      }
    },
  );

  // GET /chat/sessions/:id/messages — get messages + persisted step events for
  // a session. The `events` array lets the web client rebuild the full chat
  // panel (agent activity blocks, tool calls, panel-added notices, etc.)
  // exactly as it looked during the live run.
  router.get(
    '/sessions/:id/messages',
    requirePermission(() => ac.eval(ACTIONS.ChatUse)),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const sessionId = req.params['id'] ?? '';
        if (!sessionId) {
          res.status(400).json({
            error: {
              code: 'INVALID_INPUT',
              message: 'session id is required',
            },
          });
          return;
        }
        const auth = (req as AuthenticatedRequest).auth;
        const ownerScope = auth
          ? { orgId: auth.orgId, ownerUserId: auth.userId }
          : undefined;
        if (!(await ensureSessionInOrg(deps, sessionId, ownerScope))) {
          res.status(404).json({
            error: { code: 'NOT_FOUND', message: 'Chat session not found' },
          });
          return;
        }

        const [messages, events, queuedMessages] = await Promise.all([
          deps.chatMessageStore
            ? deps.chatMessageStore.getMessages(sessionId)
            : Promise.resolve([]),
          deps.chatEventStore
            ? deps.chatEventStore.listBySession(sessionId)
            : Promise.resolve([]),
          deps.chatMessageQueueStore
            ? deps.chatMessageQueueStore.listBySession(sessionId)
            : Promise.resolve([]),
        ]);
        const pendingQueuedMessages = queuedMessages.filter((item) => item.status === 'queued');
        res.json({
          sessionId,
          messages,
          events,
          queuedMessages: pendingQueuedMessages,
        });
        if (pendingQueuedMessages.length > 0) {
          pumpSessionQueue(deps, runRegistry, sessionEventBus, sessionId);
        }
      } catch (err) {
        next(err);
      }
    },
  );

  router.patch(
    '/sessions/:id/queue/:queueItemId',
    requirePermission(() => ac.eval(ACTIONS.ChatUse)),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const auth = (req as AuthenticatedRequest).auth;
        if (!auth) {
          res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'authentication required' } });
          return;
        }
        if (!deps.chatMessageQueueStore) {
          res.status(501).json({ error: { code: 'NOT_IMPLEMENTED', message: 'chat queue not configured' } });
          return;
        }
        const sessionId = req.params['id'] ?? '';
        const queueItemId = req.params['queueItemId'] ?? '';
        const content = typeof req.body?.content === 'string' ? req.body.content.trim() : '';
        if (!sessionId || !queueItemId || !content) {
          res.status(400).json({ error: { code: 'INVALID_INPUT', message: 'session id, queue item id, and content are required' } });
          return;
        }
        const ownerScope = { orgId: auth.orgId, ownerUserId: auth.userId };
        if (!(await ensureSessionInOrg(deps, sessionId, ownerScope))) {
          res.status(404).json({ error: { code: 'NOT_FOUND', message: 'session not found' } });
          return;
        }
        const existing = (await deps.chatMessageQueueStore.listBySession(sessionId)).find(
          (item) => item.id === queueItemId && item.status === 'queued',
        );
        if (!existing || existing.orgId !== auth.orgId || existing.ownerUserId !== auth.userId) {
          res.status(404).json({ error: { code: 'NOT_FOUND', message: 'queued message not found' } });
          return;
        }
        const updated = await deps.chatMessageQueueStore.updateQueuedContent(queueItemId, content);
        if (!updated) {
          res.status(409).json({ error: { code: 'CONFLICT', message: 'queued message already started' } });
          return;
        }
        await publishSessionEvent(deps, sessionEventBus, sessionId, {
          type: 'message_queue_updated',
          queueItemId,
          sessionId,
          content: updated.content,
        });
        res.json({ queuedMessage: updated });
      } catch (err) {
        next(err);
      }
    },
  );

  router.delete(
    '/sessions/:id/queue/:queueItemId',
    requirePermission(() => ac.eval(ACTIONS.ChatUse)),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const auth = (req as AuthenticatedRequest).auth;
        if (!auth) {
          res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'authentication required' } });
          return;
        }
        if (!deps.chatMessageQueueStore) {
          res.status(501).json({ error: { code: 'NOT_IMPLEMENTED', message: 'chat queue not configured' } });
          return;
        }
        const sessionId = req.params['id'] ?? '';
        const queueItemId = req.params['queueItemId'] ?? '';
        if (!sessionId || !queueItemId) {
          res.status(400).json({ error: { code: 'INVALID_INPUT', message: 'session id and queue item id are required' } });
          return;
        }
        const ownerScope = { orgId: auth.orgId, ownerUserId: auth.userId };
        if (!(await ensureSessionInOrg(deps, sessionId, ownerScope))) {
          res.status(404).json({ error: { code: 'NOT_FOUND', message: 'session not found' } });
          return;
        }
        const existing = (await deps.chatMessageQueueStore.listBySession(sessionId)).find(
          (item) => item.id === queueItemId && item.status === 'queued',
        );
        if (!existing || existing.orgId !== auth.orgId || existing.ownerUserId !== auth.userId) {
          res.status(404).json({ error: { code: 'NOT_FOUND', message: 'queued message not found' } });
          return;
        }
        const deleted = await deps.chatMessageQueueStore.deleteQueued(queueItemId);
        if (!deleted) {
          res.status(409).json({ error: { code: 'CONFLICT', message: 'queued message already started' } });
          return;
        }
        await publishSessionEvent(deps, sessionEventBus, sessionId, {
          type: 'message_queue_deleted',
          queueItemId,
          sessionId,
        });
        res.status(204).end();
      } catch (err) {
        next(err);
      }
    },
  );

  // GET /chat/sessions/:id/events/stream?since=N — open-ended SSE that
  // replays persisted events with seq > N then live-tails new events for
  // this session. Designed to be opened ONCE per browser tab on session
  // open and kept alive across user actions; sendMessage is a separate
  // POST that does NOT consume any SSE stream itself.
  //
  // Race-free handoff (see session-event-bus.ts for the contract): we
  // subscribe to the bus BEFORE querying the DB, buffer incoming bus
  // events, then emit DB rows, then drain the buffer skipping anything
  // with seq <= the max DB seq we just emitted. After drain we forward
  // bus events directly.
  router.get(
    '/sessions/:id/events/stream',
    requirePermission(() => ac.eval(ACTIONS.ChatUse)),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const sessionId = req.params['id'] ?? '';
        if (!sessionId) {
          res.status(400).json({ error: { code: 'INVALID_INPUT', message: 'session id is required' } });
          return;
        }
        const auth = (req as AuthenticatedRequest).auth;
        if (!auth) {
          res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'authentication required' } });
          return;
        }
        const ownerScope = { orgId: auth.orgId, ownerUserId: auth.userId };
        if (!(await ensureSessionInOrg(deps, sessionId, ownerScope))) {
          res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Chat session not found' } });
          return;
        }
        // Tighter parse: only accept integers (rejects "1.5e10" type junk
        // a sloppy client might send) and floor at -1 so seq>=0 always
        // wins inclusion. -1 is the "I've seen nothing yet" sentinel.
        const sinceRaw = req.query['since'];
        const since = typeof sinceRaw === 'string' ? Number(sinceRaw) : NaN;
        const sinceSeq = Number.isInteger(since) && since >= -1 ? since : -1;

        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
          'X-Accel-Buffering': 'no',
        });

        let closed = false;
        // Buffer bus events that arrive while we're querying the DB so we
        // don't lose any in the handoff window.
        const handoffBuffer: SessionBusEvent[] = [];
        let liveMode = false;
        let maxEmittedSeq = sinceSeq;

        const writeEvent = (seq: number, event: DashboardSseEvent) => {
          if (closed) return;
          if (seq <= maxEmittedSeq) return; // dedupe
          maxEmittedSeq = seq;
          // Include the seq as the SSE `id:` field so a reconnecting client
          // can resume with ?since={lastId} cleanly.
          res.write(`id: ${seq}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
        };

        let subscription: { close(): void } | undefined;
        if (sessionEventBus) {
          subscription = sessionEventBus.subscribe(sessionId, (payload) => {
            if (closed) return;
            // Snapshot the mode bit once per delivery so a future async
            // edit between the check and the action can't accidentally
            // split this handler across the handoff boundary (review
            // finding #7). Node EventEmitter delivery is sync today so
            // this is belt-and-suspenders, but it makes the invariant
            // local rather than file-wide.
            const mode = liveMode;
            if (mode) writeEvent(payload.seq, payload.event);
            else handoffBuffer.push(payload);
          });
        }

        const heartbeat = setInterval(() => {
          if (!closed) res.write(': heartbeat\n\n');
        }, 30_000);

        const cleanup = () => {
          closed = true;
          clearInterval(heartbeat);
          subscription?.close();
        };
        res.on('close', cleanup);

        try {
          if (deps.chatEventStore) {
            // TODO: add a seq-filtered list method to the repo to avoid
            // loading every event when sinceSeq is large.
            const rows = await deps.chatEventStore.listBySession(sessionId);
            for (const row of rows) {
              if (closed) break;
              if (row.seq <= sinceSeq) continue;
              writeEvent(row.seq, row.payload as unknown as DashboardSseEvent);
            }
          }
          // Drain anything the bus delivered during the query.
          for (const payload of handoffBuffer) {
            if (closed) break;
            writeEvent(payload.seq, payload.event);
          }
          handoffBuffer.length = 0;
          liveMode = true;

          // If the session's run already finished and there's no live
          // publisher, tell the client so it can close the connection
          // instead of holding it open forever.
          if (runRegistry) {
            const active = runRegistry.activeRunFor(sessionId);
            if (!active) {
              res.write(`event: idle\ndata: ${JSON.stringify({ type: 'idle' })}\n\n`);
            }
          }
        } catch (err) {
          log.error({ err, sessionId }, 'events stream replay failed');
          if (!closed) {
            res.write(`event: error\ndata: ${JSON.stringify({ type: 'error', message: 'replay failed' })}\n\n`);
          }
        }
        // Keep the response open; cleanup runs on res 'close'.
      } catch (err) {
        next(err);
      }
    },
  );

  // POST /chat/sessions/:id/cancel-active — cancel whichever run is
  // currently active on this session, without the caller needing to know
  // the runId. Two motivating cases:
  //   1. Stop button clicked before the first `run_started` SSE event
  //      arrived — the client doesn't yet know the runId.
  //   2. User starts a new turn while the previous one is still running
  //      (impatient resend); the new POST should atomically cancel-old +
  //      start-new without the client juggling runIds.
  // Returns 204 on success, 404 when no active run exists.
  router.post(
    '/sessions/:id/cancel-active',
    requirePermission(() => ac.eval(ACTIONS.ChatUse)),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        if (!runRegistry) {
          res.status(501).json({
            error: { code: 'NOT_IMPLEMENTED', message: 'run registry not configured' },
          });
          return;
        }
        const auth = (req as AuthenticatedRequest).auth;
        if (!auth) {
          res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'authentication required' } });
          return;
        }
        const sessionId = req.params['id'] ?? '';
        if (!sessionId) {
          res.status(400).json({ error: { code: 'INVALID_INPUT', message: 'session id required' } });
          return;
        }
        const ownerScope = { orgId: auth.orgId, ownerUserId: auth.userId };
        if (!(await ensureSessionInOrg(deps, sessionId, ownerScope))) {
          res.status(404).json({ error: { code: 'NOT_FOUND', message: 'session not found' } });
          return;
        }
        const active = runRegistry.activeRunFor(sessionId);
        if (!active || active.status !== 'running') {
          // 204 (rather than 404) on "nothing to cancel" so the client can
          // call this defensively without distinguishing "no run" from
          // "already finished" — both mean "you don't need to wait".
          pumpSessionQueue(deps, runRegistry, sessionEventBus, sessionId);
          res.status(204).end();
          return;
        }
        runRegistry.cancel(active.runId);
        res.json({ runId: active.runId, status: 'aborting' });
      } catch (err) {
        next(err);
      }
    },
  );

  // POST /chat/runs/:runId/cancel — explicit cancel for a detached agent
  // run by runId. Less convenient than /sessions/:id/cancel-active (caller
  // must know the runId) but useful when the caller wants exact targeting
  // — e.g. a Stop button that fires immediately after run_started arrived.
  // Idempotent: cancelling a finished run returns 409.
  router.post(
    '/runs/:runId/cancel',
    requirePermission(() => ac.eval(ACTIONS.ChatUse)),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        if (!runRegistry) {
          res.status(501).json({
            error: { code: 'NOT_IMPLEMENTED', message: 'run registry not configured' },
          });
          return;
        }
        const auth = (req as AuthenticatedRequest).auth;
        if (!auth) {
          res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'authentication required' } });
          return;
        }
        const runId = req.params['runId'] ?? '';
        const record = runRegistry.get(runId);
        if (!record || record.orgId !== auth.orgId) {
          res.status(404).json({ error: { code: 'NOT_FOUND', message: 'run not found' } });
          return;
        }
        if (record.status !== 'running') {
          res.status(409).json({
            error: { code: 'CONFLICT', message: `run is already ${record.status}` },
            status: record.status,
          });
          return;
        }
        runRegistry.cancel(runId);
        res.json({ runId, status: 'aborting' });
      } catch (err) {
        next(err);
      }
    },
  );

  return router;
}
