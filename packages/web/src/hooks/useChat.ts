import { useState, useCallback, useRef, useEffect, useMemo } from 'react';
import { apiClient } from '../api/client.js';
import { subscribeStream, BASE_URL } from '../api/client.js';
import type { ChatMessage, ChatEvent } from './useDashboardChat.js';
import { parseAskUserPayload, parseInlineChartPayload } from './useDashboardChat.js';

/** Page context — tells the agent what the user is currently looking at. */
export interface PageContext {
  /** e.g., "dashboard", "investigation", "alerts", "home" */
  kind: string;
  /** Resource ID (dashboardId, investigationId, etc.) */
  id?: string;
  /** Selected time range on the dashboard (e.g., "1h", "6h", "24h", "7d") */
  timeRange?: string;
  /** IANA timezone the panel x-axis is rendered in (browser local). The
   *  agent uses this to translate clock times the user mentions ("9:59")
   *  into the UTC range it queries. Set automatically from the browser. */
  clientTimezone?: string;
}

export interface UseChatResult {
  messages: ChatMessage[];
  events: ChatEvent[];
  isGenerating: boolean;
  sendMessage: (content: string) => Promise<void>;
  stopGeneration: () => void;
  /** Set by the backend when the agent creates a resource and emits a navigate SSE event. */
  pendingNavigation: string | null;
  clearPendingNavigation: () => void;
  /** Set the current page context — agent uses this to know which resource the user is viewing. */
  setPageContext: (ctx: PageContext | null) => void;
  /** Current durable session ID (readonly). Empty until the server creates one. */
  currentSessionId: string;
  /** Clear messages/events and start an unsaved draft session. */
  startNewSession: () => void;
  /** Load a session's messages from the backend. Handles 404 gracefully. */
  loadSession: (sessionId: string) => Promise<void>;
  /**
   * Result of the most recent `loadSession` call.
   *  - `'not-found'` — backend returned 404; the session ID is gone.
   *  - `'network'`   — any other failure (5xx, network drop, parse error).
   *  - `null`        — no error (last load succeeded, or loadSession not called).
   * Consumers (ChatPanel) render distinct UI per case instead of an
   * indistinguishable empty chat.
   */
  loadError: 'not-found' | 'network' | null;
  /** Retry the most recent loadSession call (only meaningful when `loadError === 'network'`). */
  retryLoadSession: () => void;
}

/**
 * Convert a persisted SSE payload back into the frontend ChatEvent shape used
 * by the chat panel. Mirrors the live parsing in handleSSEEvent so replayed
 * history renders identically to the live stream.
 */
export function payloadToChatEvent(
  id: string,
  kind: string,
  payload: Record<string, unknown>,
  timestamp?: string,
): ChatEvent | null {
  switch (kind) {
    case 'reply': {
      const content = (payload.content as string) ?? '';
      if (!content) return null;
      return {
        id,
        kind: 'message',
        message: {
          id,
          role: 'assistant',
          content,
          timestamp: timestamp ?? new Date().toISOString(),
        },
      };
    }
    case 'thinking':
      return {
        id,
        kind: 'thinking',
        content: (payload.content as string) ?? 'Thinking...',
      };
    case 'tool_call': {
      const params =
        payload.args && typeof payload.args === 'object' && !Array.isArray(payload.args)
          ? (payload.args as Record<string, unknown>)
          : undefined;
      return {
        id,
        kind: 'tool_call',
        tool: payload.tool as string | undefined,
        content:
          (payload.displayText as string) ?? (payload.content as string) ?? '',
        ...(params ? { params } : {}),
        ...(typeof payload.evidenceId === 'string' ? { evidenceId: payload.evidenceId } : {}),
      };
    }
    case 'tool_result': {
      const output = typeof payload.output === 'string' ? payload.output : undefined;
      return {
        id,
        kind: 'tool_result',
        tool: payload.tool as string | undefined,
        content:
          (payload.summary as string) ?? (payload.content as string) ?? '',
        success: payload.success !== false,
        ...(output ? { output } : {}),
        ...(typeof payload.evidenceId === 'string' ? { evidenceId: payload.evidenceId } : {}),
        ...(typeof payload.cost === 'number' ? { cost: payload.cost } : {}),
        ...(typeof payload.durationMs === 'number' ? { durationMs: payload.durationMs } : {}),
      };
    }
    case 'panel_added':
      return {
        id,
        kind: 'panel_added',
        panel: payload.panel as ChatEvent['panel'],
      };
    case 'panel_removed':
      return {
        id,
        kind: 'panel_removed',
        panelId: payload.panelId as string | undefined,
      };
    case 'panel_modified':
      return {
        id,
        kind: 'panel_modified',
        panelId: payload.panelId as string | undefined,
      };
    case 'ask_user': {
      const { question, options } = parseAskUserPayload(payload);
      return { id, kind: 'ask_user', question, options };
    }
    case 'inline_chart': {
      const chart = parseInlineChartPayload(payload);
      if (!chart) return null;
      return { id: chart.id, kind: 'inline_chart', inlineChart: chart };
    }
    case 'ds_choice': {
      const chosenId =
        typeof payload.chosenId === 'string' ? payload.chosenId : '';
      const chosenName = typeof payload.name === 'string' ? payload.name : '';
      const chooseReason =
        typeof payload.reason === 'string' ? payload.reason : '';
      const confidence =
        payload.confidence === 'high' ||
        payload.confidence === 'medium' ||
        payload.confidence === 'low'
          ? payload.confidence
          : 'low';
      const rawAlts = Array.isArray(payload.alternatives)
        ? payload.alternatives
        : [];
      const alternatives = rawAlts
        .map((a) => {
          if (!a || typeof a !== 'object') return null;
          const obj = a as Record<string, unknown>;
          const aid = typeof obj.id === 'string' ? obj.id : '';
          const name = typeof obj.name === 'string' ? obj.name : '';
          if (!aid || !name) return null;
          const env =
            typeof obj.environment === 'string' ? obj.environment : undefined;
          const cluster =
            typeof obj.cluster === 'string' ? obj.cluster : undefined;
          return {
            id: aid,
            name,
            ...(env ? { environment: env } : {}),
            ...(cluster ? { cluster } : {}),
          };
        })
        .filter((a): a is NonNullable<typeof a> => a !== null);
      return {
        id,
        kind: 'ds_choice',
        chosenId,
        chosenName,
        chooseReason,
        confidence,
        alternatives,
      };
    }
    case 'pending_change_created': {
      const dashboardId = typeof payload.dashboardId === 'string' ? payload.dashboardId : '';
      if (!dashboardId) return null;
      return {
        id,
        kind: 'pending_change_created',
        dashboardId,
        pendingChange: {
          id: (payload.id as string) ?? id,
          dashboardId,
          panelId: (payload.panelId as string | null | undefined) ?? null,
          summary: payload.summary as string | undefined,
          changeKind: payload.changeKind as string | undefined,
          beforeJson: payload.beforeJson,
          afterJson: payload.afterJson,
          proposedAt: payload.proposedAt as string | undefined,
          proposedBy: payload.proposedBy as string | undefined,
          status: 'pending',
        },
      };
    }
    case 'pending_change_resolved': {
      const dashboardId = typeof payload.dashboardId === 'string' ? payload.dashboardId : '';
      return {
        id,
        kind: 'pending_change_resolved',
        dashboardId,
        pendingChange: {
          id: (payload.id as string) ?? id,
          dashboardId,
          status: payload.status as string | undefined,
        },
      };
    }
    case 'ops_command_confirmation_required':
      return {
        id,
        kind: 'ops_command_confirmation_required',
        opsConfirmation: {
          id: (payload.id as string) ?? id,
          connectorId: (payload.connectorId as string) ?? '',
          command: (payload.command as string) ?? '',
          risk: payload.risk as 'low' | 'medium' | 'high' | 'critical' | undefined,
          summary: payload.summary as string | undefined,
          expiresAt: payload.expiresAt as string | undefined,
          status: 'expired',
          error: 'This confirmation was from a previous chat load. Ask Rounds to propose the command again.',
        },
      };
    case 'ops_command_confirmation_resolved':
      return {
        id,
        kind: 'ops_command_confirmation_resolved',
        opsConfirmation: {
          id: (payload.id as string) ?? id,
          connectorId: '',
          command: '',
          status: payload.status as 'executed' | 'rejected' | 'expired' | 'failed' | undefined,
          output: payload.output as string | undefined,
          error: payload.error as string | undefined,
        },
      };
    case 'error':
      return {
        id,
        kind: 'error',
        content:
          (payload.message as string) ??
          (payload.content as string) ??
          'An error occurred',
      };
    default:
      // Kinds we intentionally don't replay: variable_added / investigation_report
      // are reflected in dashboard state, not chat history; agent_event /
      // verification_report / approval_required aren't currently rendered.
      return null;
  }
}

export interface PersistedChatSessionEvent {
  id: string;
  seq: number;
  kind: string;
  payload: Record<string, unknown>;
  timestamp: string;
}

export function rebuildChatEventsFromSession(
  messages: ChatMessage[],
  persistedEvents: PersistedChatSessionEvent[] = [],
): ChatEvent[] {
  const hasPersistedReplies = persistedEvents.some((evt) => evt.kind === 'reply');

  type Entry =
    | { kind: 'msg'; ts: string; message: ChatMessage }
    | { kind: 'evt'; ts: string; seq: number; evt: ChatEvent };

  const entries: Entry[] = [];
  for (const msg of messages) {
    if (msg.role === 'assistant' && hasPersistedReplies) continue;
    entries.push({ kind: 'msg', ts: msg.timestamp, message: msg });
  }
  for (const raw of persistedEvents) {
    const evt = payloadToChatEvent(raw.id, raw.kind, raw.payload, raw.timestamp);
    if (evt) {
      entries.push({
        kind: 'evt',
        ts: raw.timestamp,
        seq: raw.seq,
        evt,
      });
    }
  }
  entries.sort((a, b) => {
    if (a.ts !== b.ts) return a.ts < b.ts ? -1 : 1;
    const aSeq = a.kind === 'evt' ? a.seq : -Infinity;
    const bSeq = b.kind === 'evt' ? b.seq : -Infinity;
    return aSeq - bSeq;
  });

  return entries.map((entry) =>
    entry.kind === 'msg'
      ? { id: entry.message.id, kind: 'message', message: entry.message }
      : entry.evt,
  );
}

// withChatQuery used to append `?chat=<id>` to agent-emitted navigation paths
// so the destination page could rebind the same chat. That's now redundant:
// currentSessionId lives in ChatProvider's React state and persists across
// route changes within the tab. URL-based session restore was also a source
// of stale-id bugs (see preceding commits) and is no longer the model.

/**
 * Global chat hook — not tied to any specific dashboard.
 * Calls POST /api/chat and handles SSE events the same way useDashboardChat does.
 */
export function useChat(): UseChatResult {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [events, setEvents] = useState<ChatEvent[]>([]);
  const [isGenerating, setIsGenerating] = useState(false);
  const [pendingNavigation, setPendingNavigation] = useState<string | null>(
    null,
  );
  const [loadError, setLoadError] = useState<'not-found' | 'network' | null>(
    null,
  );
  const lastLoadSessionIdRef = useRef<string | null>(null);
  // Monotonic token bumped on every loadSession() call. A stale completion
  // (slow network) checks this against its captured token and bails if a
  // newer load has started — otherwise it would clobber the fresher session's
  // messages with whatever the older request returned.
  const loadTokenRef = useRef(0);
  const pageContextRef = useRef<PageContext | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  // Live-tail subscription to /chat/sessions/:id/events/stream. Open at
  // most one per mounted hook instance. Lifecycle:
  //   - opened by loadSession after history loads (so the user keeps
  //     seeing live events from a still-running agent in this session)
  //   - opened by sendMessage after the in-request SSE response closes
  //     (covers the "agent emits more events after `done`" + tail)
  //   - closed by the next loadSession/startNewSession or unmount
  // Dedup against in-request events via maxSeqRef.
  const subscriptionAbortRef = useRef<AbortController | null>(null);
  const maxSeqRef = useRef<number>(-1);
  // The active background runId for the in-progress generation. Captured
  // from the `run_started` SSE event the backend emits at the top of every
  // chat run (see Phase 1 in api-gateway/routes/chat.ts). Used by
  // stopGeneration to POST /chat/runs/:runId/cancel — since the backend
  // no longer cancels on client-disconnect, the local abort alone wouldn't
  // actually stop the agent.
  const runIdRef = useRef<string | null>(null);
  // True while the POST /chat stream is active. The chat-service emits the
  // same events on both the in-request stream AND the live bus, so if a
  // bus subscription is also open during the POST we'd double-render every
  // event. While this flag is set, the subscription path drops everything
  // except `idle` (which is harmless control signalling).
  const postStreamActiveRef = useRef(false);
  // Session id source of truth: the URL (`?chat=<id>`) for deeplinks plus the
  // Recents list on Home for picking a prior conversation. There used to be a
  // `localStorage.chat_session_id` mirror here so a new tab would auto-resume
  // the last conversation — but that cached a server-side session id without
  // any validation contract, so when the server-side session was gone (DB
  // reset, expired, different user) the client cheerfully POSTed a stale id
  // to /api/chat and got a 404. localStorage is removed: URL is canonical,
  // empty initial state = new conversation, Recents covers explicit resume.
  const [currentSessionId, setCurrentSessionId] = useState<string>('');
  const sessionIdRef = useRef<string>('');

  // Keep ref in sync with state
  useEffect(() => {
    sessionIdRef.current = currentSessionId;
  }, [currentSessionId]);

  // Best-effort cleanup of any stale id from previous app versions. Run once
  // on mount; ignored if the key was already cleared.
  useEffect(() => {
    try { localStorage.removeItem('chat_session_id'); } catch { /* ignore */ }
  }, []);

  const appendEvent = useCallback((evt: ChatEvent) => {
    setEvents((prev) => [...prev, evt]);
  }, []);

  /**
   * Append OR replace by `inline_chart`'s derived id (same content collapses
   * to one bubble across the session). Mirrors useDashboardChat.
   */
  const upsertInlineChart = useCallback((evt: ChatEvent, chartId: string) => {
    setEvents((prev) => {
      const idx = prev.findIndex(
        (e) => e.kind === 'inline_chart' && e.inlineChart?.id === chartId,
      );
      if (idx === -1) return [...prev, evt];
      const next = prev.slice();
      next[idx] = evt;
      return next;
    });
  }, []);

  const clearPendingNavigation = useCallback(() => {
    setPendingNavigation(null);
  }, []);

  const handleSSEEvent = useCallback(
    (eventType: string, rawData: string) => {
      let parsed: Record<string, unknown> = {};
      try {
        parsed = JSON.parse(rawData) as Record<string, unknown>;
      } catch {
        parsed = { content: rawData };
      }

      const resolvedType =
        eventType === 'message' && typeof parsed.type === 'string'
          ? parsed.type
          : eventType;

      const id = crypto.randomUUID();

      // Terminal `idle` from the live-tail bus — the orchestrator finished
      // and the session is no longer generating. Always clear the spinner,
      // even if this is the only terminator we see (e.g. a session reopened
      // after `done` was already persisted, then the subscription replays
      // tail events and the next bus signal is `idle`).
      if (resolvedType === 'idle') {
        setIsGenerating(false);
        return;
      }

      switch (resolvedType) {
        // Backend-emitted at the start of every detached agent run (Phase 1).
        // We don't surface it in the UI but we MUST capture the sessionId
        // it carries: on a brand-new chat the client hasn't seen a `done`
        // event yet so sessionIdRef is still empty, and a Stop click would
        // be a no-op (cancel-active needs the sessionId). Setting it here
        // closes that window — by the time the first agent token streams,
        // we already have the session id and Stop works.
        case 'run_started': {
          const rid = parsed['runId'];
          const sid = parsed['sessionId'];
          if (typeof rid === 'string') runIdRef.current = rid;
          if (typeof sid === 'string' && !sessionIdRef.current) {
            sessionIdRef.current = sid;
            setCurrentSessionId(sid);
          }
          break;
        }

        case 'thinking': {
          appendEvent({
            id,
            kind: 'thinking',
            content: (parsed.content as string) ?? 'Thinking...',
          });
          break;
        }

        case 'tool_call': {
          appendEvent({
            id,
            kind: 'tool_call',
            tool: parsed.tool as string | undefined,
            content:
              (parsed.displayText as string) ??
              (parsed.content as string) ??
              '',
          });
          break;
        }

        case 'tool_result': {
          appendEvent({
            id,
            kind: 'tool_result',
            tool: parsed.tool as string | undefined,
            content:
              (parsed.summary as string) ?? (parsed.content as string) ?? '',
            success: parsed.success !== false,
          });
          break;
        }

        case 'panel_added': {
          appendEvent({
            id,
            kind: 'panel_added',
            panel: parsed.panel as ChatEvent['panel'],
          });
          break;
        }

        case 'panel_removed': {
          appendEvent({
            id,
            kind: 'panel_removed',
            panelId: parsed.panelId as string | undefined,
          });
          break;
        }

        case 'panel_modified': {
          appendEvent({
            id,
            kind: 'panel_modified',
            panelId: parsed.panelId as string | undefined,
          });
          break;
        }

        case 'pending_change_created': {
          // Render inline ChangeProposalCard in the chat stream.
          appendEvent({
            id,
            kind: 'pending_change_created',
            dashboardId: parsed.dashboardId as string | undefined,
            pendingChange: {
              id: (parsed.id as string) ?? id,
              dashboardId: (parsed.dashboardId as string) ?? '',
              panelId: (parsed.panelId as string | null | undefined) ?? null,
              summary: parsed.summary as string | undefined,
              changeKind: parsed.changeKind as string | undefined,
              beforeJson: parsed.beforeJson,
              afterJson: parsed.afterJson,
              proposedAt: parsed.proposedAt as string | undefined,
              proposedBy: parsed.proposedBy as string | undefined,
              status: 'pending',
            },
          });
          break;
        }

        case 'pending_change_resolved': {
          // The corresponding ChangeProposalCard tracks its own status; we
          // still emit the event so chat history replay can carry the
          // resolution forward.
          appendEvent({
            id,
            kind: 'pending_change_resolved',
            dashboardId: parsed.dashboardId as string | undefined,
            pendingChange: {
              id: (parsed.id as string) ?? id,
              dashboardId: (parsed.dashboardId as string) ?? '',
              status: parsed.status as string | undefined,
            },
          });
          break;
        }

        case 'ops_command_confirmation_required': {
          appendEvent({
            id,
            kind: 'ops_command_confirmation_required',
            opsConfirmation: {
              id: (parsed.id as string) ?? id,
              connectorId: (parsed.connectorId as string) ?? '',
              command: (parsed.command as string) ?? '',
              risk: parsed.risk as 'low' | 'medium' | 'high' | 'critical' | undefined,
              summary: parsed.summary as string | undefined,
              expiresAt: parsed.expiresAt as string | undefined,
              status: 'pending',
            },
          });
          break;
        }

        case 'ops_command_confirmation_resolved': {
          appendEvent({
            id,
            kind: 'ops_command_confirmation_resolved',
            opsConfirmation: {
              id: (parsed.id as string) ?? id,
              connectorId: '',
              command: '',
              status: parsed.status as 'executed' | 'rejected' | 'expired' | 'failed' | undefined,
              output: parsed.output as string | undefined,
              error: parsed.error as string | undefined,
            },
          });
          break;
        }

        case 'navigate': {
          const path = (parsed.path as string) ?? '';
          if (path) {
            setPendingNavigation(path);
          }
          break;
        }

        case 'reply': {
          const content = (parsed.content as string) ?? '';
          const aiMsg: ChatMessage = {
            id,
            role: 'assistant',
            content,
            timestamp: new Date().toISOString(),
          };
          setMessages((prev) => [...prev, aiMsg]);
          appendEvent({ id, kind: 'message', message: aiMsg });
          break;
        }

        case 'ask_user': {
          const { question, options } = parseAskUserPayload(parsed);
          appendEvent({ id, kind: 'ask_user', question, options });
          break;
        }

        case 'ds_choice': {
          const evt = payloadToChatEvent(id, 'ds_choice', parsed);
          if (evt) appendEvent(evt);
          break;
        }

        case 'inline_chart': {
          const chart = parseInlineChartPayload(parsed);
          if (chart) {
            upsertInlineChart(
              { id: chart.id, kind: 'inline_chart', inlineChart: chart },
              chart.id,
            );
          }
          break;
        }

        case 'done': {
          const durableSessionId =
            typeof parsed.sessionId === 'string' && parsed.sessionId.trim()
              ? parsed.sessionId.trim()
              : '';
          if (durableSessionId && durableSessionId !== sessionIdRef.current) {
            sessionIdRef.current = durableSessionId;
            setCurrentSessionId(durableSessionId);
          }

          // Check if done carries a navigate directive as well
          const navigateTo = parsed.navigate as string | undefined;
          if (navigateTo) {
            setPendingNavigation(navigateTo);
          }
          appendEvent({ id, kind: 'done', content: 'Generation complete' });
          // The subscription path needs to drop the spinner when `done`
          // arrives. The sendMessage path also reaches this case (via
          // its in-request stream callback) and would set the flag false
          // a beat before its own finally — either way, harmless.
          setIsGenerating(false);
          break;
        }

        case 'error': {
          const content =
            (parsed.message as string) ??
            (parsed.content as string) ??
            'An error occurred';
          appendEvent({ id, kind: 'error', content });
          setIsGenerating(false);
          break;
        }

        default:
          break;
      }
    },
    [appendEvent, upsertInlineChart],
  );

  /**
   * Open a live-tail subscription to /chat/sessions/:id/events/stream
   * starting at sinceSeq+1. Closes any previously-open subscription.
   * Events flow through handleSSEEvent for identical rendering vs. the
   * in-request stream; we dedupe by seq via maxSeqRef so an event that
   * already came through the in-request callback isn't re-rendered when
   * the subscription replays the same seq.
   */
  const openSubscription = useCallback(
    (subscribeToSessionId: string, sinceSeq: number) => {
      // Tear down any prior subscription (e.g. from a previous session).
      subscriptionAbortRef.current?.abort();
      const controller = new AbortController();
      subscriptionAbortRef.current = controller;
      maxSeqRef.current = sinceSeq;
      // BASE_URL is already `/api` (see api/config.ts). Don't double-prefix.
      const url = `/chat/sessions/${encodeURIComponent(subscribeToSessionId)}/events/stream`;
      const getReconnectUrl = () =>
        `${url}?since=${encodeURIComponent(String(maxSeqRef.current))}`;
      void subscribeStream(
        BASE_URL,
        getReconnectUrl,
        (sseId, eventType, rawData) => {
          // Dedup by seq — the SSE `id:` field carries the persisted seq.
          if (sseId != null) {
            const seq = Number(sseId);
            if (Number.isFinite(seq)) {
              if (seq <= maxSeqRef.current) return;
              maxSeqRef.current = seq;
            }
          }
          // While the POST /chat stream is active, the in-request callback
          // already delivers every event we care about — the bus mirror
          // would double-render. Drop everything except `idle`, which is a
          // useful safety terminator (clears the spinner if `done` is
          // somehow missed).
          if (postStreamActiveRef.current && eventType !== 'idle') return;
          handleSSEEvent(eventType, rawData);
        },
        controller.signal,
      ).catch((err: unknown) => {
        // Aborted = caller closed us, expected. Anything else logs.
        if (err instanceof DOMException && err.name === 'AbortError') return;
        console.warn('[useChat] events subscription error', err);
      });
    },
    [handleSSEEvent],
  );

  const sendMessage = useCallback(
    async (content: string) => {
      if (!content.trim() || isGenerating) return;

      // Cancel-by-sessionId for the prior run (if any). Works whether or
      // not we ever received `run_started` for that turn — server looks
      // up activeRunFor(sessionId). Backend's POST /chat handler waits
      // briefly for the cancelled run to release before starting the
      // new one, closing the markComplete→releaseSession gap window.
      const sid = sessionIdRef.current;
      if (sid) {
        void apiClient
          .post(`/chat/sessions/${encodeURIComponent(sid)}/cancel-active`, {})
          .catch(() => undefined);
      }
      abortRef.current?.abort();
      abortRef.current = new AbortController();
      // Fresh run — backend's `run_started` SSE event will repopulate.
      runIdRef.current = null;

      const userMsg: ChatMessage = {
        id: crypto.randomUUID(),
        role: 'user',
        content,
        timestamp: new Date().toISOString(),
      };
      setMessages((prev) => [...prev, userMsg]);
      appendEvent({ id: userMsg.id, kind: 'message', message: userMsg });
      setIsGenerating(true);

      postStreamActiveRef.current = true;
      try {
        // Always inject the browser's local timezone so the agent can map
        // any clock time the user mentions ("9:59" off the panel's x-axis)
        // back to the UTC range it actually queries against.
        const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
        const ctxWithTz = pageContextRef.current
          ? { ...pageContextRef.current, clientTimezone: tz }
          : { kind: 'home', clientTimezone: tz };
        const sid = sessionIdRef.current;
        await apiClient.postStream(
          '/chat',
          {
            message: content,
            ...(sid ? { sessionId: sid } : {}),
            pageContext: ctxWithTz,
          },
          handleSSEEvent,
          abortRef.current.signal,
        );
        // A successful round-trip means the session is reachable — drop any
        // stale loadError banner so it doesn't linger after a transient blip.
        setLoadError(null);
      } catch (err) {
        if (err instanceof Error && err.name !== 'AbortError') {
          // Genuine failures now: auth gate (handled with its own message in
          // streaming.ts), permission denied (ditto), transport / 5xx, or a
          // 404 caused by a session that was deleted server-side mid-flight
          // (rare; deserves an honest message). The old "endpoint not available
          // yet" fallback was misleading: the endpoint exists, the stale
          // sessionId was the bug, and that bug is now fixed at its source.
          appendEvent({
            id: crypto.randomUUID(),
            kind: 'error',
            content: err.message,
          });
        }
      } finally {
        postStreamActiveRef.current = false;
        setIsGenerating(false);
      }
    },
    [isGenerating, handleSSEEvent, appendEvent],
  );

  const setPageContext = useCallback((ctx: PageContext | null) => {
    const prev = pageContextRef.current;
    pageContextRef.current = ctx;
    // When navigating to a page that has a resource context (dashboard /
    // investigation / alert), and we don't already have a session loaded
    // for THIS resource, look up the most-recent owned chat session for
    // it and resume. Falls back to blank state if none exists.
    if (
      ctx?.id &&
      (ctx.kind === 'dashboard' || ctx.kind === 'investigation' || ctx.kind === 'alert') &&
      (!prev || prev.id !== ctx.id || prev.kind !== ctx.kind)
    ) {
      const resourceType = ctx.kind;
      const resourceId = ctx.id;
      void (async () => {
        try {
          const res = await apiClient.get<{ sessions: Array<{ id: string }> }>(
            `/chat/sessions/by-context?resourceType=${encodeURIComponent(resourceType)}&resourceId=${encodeURIComponent(resourceId)}&limit=1`,
          );
          const latest = res.data?.sessions?.[0];
          if (latest?.id && latest.id !== sessionIdRef.current) {
            await loadSessionRef.current?.(latest.id);
          } else if (!latest) {
            // No session yet for this resource — leave the panel empty so
            // user sees the "ask me anything" prompt rather than the prior
            // page's conversation bleeding through.
            if (sessionIdRef.current) {
              setEvents([]);
              setCurrentSessionId('');
              sessionIdRef.current = '';
            }
          }
        } catch {
          // Non-fatal: leave whatever state was there.
        }
      })();
    }
  }, []);
  // Ref-forward to loadSession (declared below) so the effect above can
  // call it without hoisting issues.
  const loadSessionRef = useRef<((id: string) => Promise<void>) | null>(null);

  const stopGeneration = useCallback(() => {
    // Backend Phase 1: client disconnect no longer cancels the agent — to
    // actually stop the run we POST a cancel. Use the cancel-by-sessionId
    // endpoint instead of cancel-by-runId so it works even when the user
    // clicked Stop BEFORE `run_started` arrived (the runId-keyed variant
    // would be a no-op in that window). Server resolves the active run
    // for the session and aborts it; 204 if there's nothing to cancel.
    const sid = sessionIdRef.current;
    if (sid) {
      void apiClient
        .post(`/chat/sessions/${encodeURIComponent(sid)}/cancel-active`, {})
        .catch(() => undefined);
    }
    abortRef.current?.abort();
    abortRef.current = null;
    runIdRef.current = null;
    setIsGenerating(false);
    appendEvent({
      id: crypto.randomUUID(),
      kind: 'message',
      message: {
        id: crypto.randomUUID(),
        role: 'assistant',
        content: 'Stopped.',
        timestamp: new Date().toISOString(),
      },
    });
  }, [appendEvent]);

  const startNewSession = useCallback(() => {
    loadTokenRef.current += 1;
    // Intentionally DO NOT cancel the prior session's run. The user
    // wants a fresh conversation alongside the existing one — the prior
    // agent should keep running in the background so its events keep
    // accumulating in chat_session_events and the user can switch back
    // later to see it complete. This is what makes "multiple concurrent
    // conversations" actually work.
    //
    // Local abort just closes our SSE stream + live-tail subscription
    // for the prior session; backend Phase 1 keeps the agent alive.
    abortRef.current?.abort();
    abortRef.current = null;
    subscriptionAbortRef.current?.abort();
    subscriptionAbortRef.current = null;
    runIdRef.current = null;
    maxSeqRef.current = -1;
    setMessages([]);
    setEvents([]);
    setIsGenerating(false);
    setPendingNavigation(null);
    // A previous session's load error must not leak into the new one — the
    // banner would otherwise sit on top of a fresh empty chat.
    setLoadError(null);
    lastLoadSessionIdRef.current = null;
    sessionIdRef.current = '';
    setCurrentSessionId('');
  }, []);

  const loadSession = useCallback(async (sessionId: string) => {
    // Bump the token before any await — every subsequent stale completion
    // sees a higher token and bails. Capture the token for THIS call so we
    // can compare it against the latest after the request resolves.
    const token = ++loadTokenRef.current;

    // Detach from the prior session's SSE stream + live-tail
    // subscription — without these, the previous session's events would
    // pollute the newly-loaded session's UI. Backend Phase 1 keeps the
    // prior agent running in the background, persisting events to
    // chat_session_events so they're visible when the user switches back.
    abortRef.current?.abort();
    abortRef.current = null;
    subscriptionAbortRef.current?.abort();
    subscriptionAbortRef.current = null;
    runIdRef.current = null;
    maxSeqRef.current = -1;

    // Switch to the requested session
    setCurrentSessionId(sessionId);
    setMessages([]);
    setEvents([]);
    setIsGenerating(false);
    setPendingNavigation(null);
    setLoadError(null);
    lastLoadSessionIdRef.current = sessionId;

    try {
      const res = await apiClient.get<{
        sessionId: string;
        messages: ChatMessage[];
        events?: PersistedChatSessionEvent[];
      }>(`/chat/sessions/${sessionId}/messages`);

      if (token !== loadTokenRef.current) {
        // A newer loadSession() started while this request was in flight.
        // Drop the result silently — committing it would overwrite the
        // newer session's freshly loaded state with stale data.
        return;
      }

      if (res.error) {
        // apiClient surfaces backend errors via the `{ data, error }` envelope.
        // Distinguish 404 (the session genuinely doesn't exist on the server)
        // from any other failure (5xx, transport, etc.) so the UI can render
        // the right empty-state instead of a blank chat with no signal.
        const errStatus = Number(
          (res.error as unknown as Record<string, unknown>).status,
        );
        const code = res.error.code ?? '';
        const msg = res.error.message ?? '';
        const is404 =
          errStatus === 404 || code === 'NOT_FOUND' || /not\s*found/i.test(msg);
        console.error('[useChat] loadSession failed', {
          sessionId,
          error: res.error,
        });
        if (is404) {
          sessionIdRef.current = '';
          setCurrentSessionId('');
          lastLoadSessionIdRef.current = null;
        }
        setLoadError(is404 ? 'not-found' : 'network');
        return;
      }

      if (!res.data?.messages) {
        // Empty success — treat as a successful load of an empty session.
        return;
      }

      const loaded = res.data.messages;
      setMessages(loaded);

      const persistedEvents = res.data.events ?? [];
      setEvents(rebuildChatEventsFromSession(loaded, persistedEvents));

      // Heuristic: if the most recent persisted event isn't a terminator
      // (done / error), the agent is most likely still running. Set
      // isGenerating so the spinner shows immediately after loadSession;
      // the live-tail subscription's `done` event will clear it.
      const terminators = new Set(['done', 'error']);
      const lastKind = persistedEvents.length > 0
        ? persistedEvents[persistedEvents.length - 1]?.kind
        : undefined;
      if (lastKind && !terminators.has(lastKind)) {
        setIsGenerating(true);
      }

      // Open a live-tail subscription so the user keeps seeing new events
      // if there's still an agent running on this session in the
      // background (Phase 1 means the agent survives client disconnect).
      // sinceSeq = the max seq we just loaded; subscription delivers
      // anything with seq > that as it lands.
      const maxLoadedSeq = persistedEvents.length > 0
        ? Math.max(...persistedEvents.map((e) => e.seq))
        : -1;
      openSubscription(sessionId, maxLoadedSeq);
    } catch (err) {
      if (token !== loadTokenRef.current) {
        // Same race guard for thrown errors — a stale failure must not
        // surface a banner over the newer in-flight load.
        return;
      }
      // Network drop or unexpected exception (e.g. JSON parse failure on a
      // non-JSON response). Treat as a generic transport error so the UI
      // renders the retryable banner.
      console.error('[useChat] loadSession threw', { sessionId, error: err });
      setLoadError('network');
    }
  }, [openSubscription]);

  const retryLoadSession = useCallback(() => {
    const sid = lastLoadSessionIdRef.current;
    if (sid) void loadSession(sid);
  }, [loadSession]);

  // Forward-ref so setPageContext (defined above) can call loadSession
  // without hoisting issues — both stay stable for the component lifetime.
  useEffect(() => {
    loadSessionRef.current = loadSession;
  }, [loadSession]);

  // Cleanup on unmount — close streams + subscription. Backend Phase 1
  // keeps the agent running regardless; the next mount reopens via
  // loadSession.
  useEffect(() => {
    return () => {
      abortRef.current?.abort();
      subscriptionAbortRef.current?.abort();
    };
  }, []);

  return useMemo(
    () => ({
      messages,
      events,
      isGenerating,
      sendMessage,
      stopGeneration,
      pendingNavigation,
      clearPendingNavigation,
      setPageContext,
      currentSessionId,
      startNewSession,
      loadSession,
      loadError,
      retryLoadSession,
    }),
    [
      messages,
      events,
      isGenerating,
      sendMessage,
      stopGeneration,
      pendingNavigation,
      clearPendingNavigation,
      setPageContext,
      currentSessionId,
      startNewSession,
      loadSession,
      loadError,
      retryLoadSession,
    ],
  );
}
