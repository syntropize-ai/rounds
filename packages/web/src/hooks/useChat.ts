import { useState, useCallback, useRef, useEffect, useMemo } from 'react';
import { apiClient } from '../api/client.js';
import type { ChatMessage, ChatEvent } from './useDashboardChat.js';
import { parseAskUserPayload } from './useDashboardChat.js';

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

function withChatQuery(path: string, sessionId: string): string {
  if (!sessionId || !path.startsWith('/')) return path;
  try {
    const url = new URL(path, window.location.origin);
    url.searchParams.set('chat', sessionId);
    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return path;
  }
}

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

      switch (resolvedType) {
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

        case 'navigate': {
          const path = (parsed.path as string) ?? '';
          if (path) {
            setPendingNavigation(withChatQuery(path, sessionIdRef.current));
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
            setPendingNavigation(
              withChatQuery(
                navigateTo,
                durableSessionId || sessionIdRef.current,
              ),
            );
          }
          appendEvent({ id, kind: 'done', content: 'Generation complete' });
          break;
        }

        case 'error': {
          const content =
            (parsed.message as string) ??
            (parsed.content as string) ??
            'An error occurred';
          appendEvent({ id, kind: 'error', content });
          break;
        }

        default:
          break;
      }
    },
    [appendEvent],
  );

  const sendMessage = useCallback(
    async (content: string) => {
      if (!content.trim() || isGenerating) return;

      abortRef.current?.abort();
      abortRef.current = new AbortController();

      const userMsg: ChatMessage = {
        id: crypto.randomUUID(),
        role: 'user',
        content,
        timestamp: new Date().toISOString(),
      };
      setMessages((prev) => [...prev, userMsg]);
      appendEvent({ id: userMsg.id, kind: 'message', message: userMsg });
      setIsGenerating(true);

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
        setIsGenerating(false);
      }
    },
    [isGenerating, handleSSEEvent, appendEvent],
  );

  const setPageContext = useCallback((ctx: PageContext | null) => {
    pageContextRef.current = ctx;
  }, []);

  const stopGeneration = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
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
    abortRef.current?.abort();
    abortRef.current = null;
    setMessages([]);
    setEvents([]);
    setIsGenerating(false);
    setPendingNavigation(null);
    // A previous session's load error must not leak into the new one — the
    // banner would otherwise sit on top of a fresh empty chat.
    setLoadError(null);
    lastLoadSessionIdRef.current = null;
    setCurrentSessionId('');
  }, []);

  const loadSession = useCallback(async (sessionId: string) => {
    // Bump the token before any await — every subsequent stale completion
    // sees a higher token and bails. Capture the token for THIS call so we
    // can compare it against the latest after the request resolves.
    const token = ++loadTokenRef.current;

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

      setEvents(rebuildChatEventsFromSession(loaded, res.data.events ?? []));
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
  }, []);

  const retryLoadSession = useCallback(() => {
    const sid = lastLoadSessionIdRef.current;
    if (sid) void loadSession(sid);
  }, [loadSession]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      abortRef.current?.abort();
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
