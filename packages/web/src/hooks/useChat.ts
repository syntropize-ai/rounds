import { useState, useCallback, useRef, useEffect, useMemo } from 'react';
import { apiClient } from '../api/client.js';
import type { ChatMessage, ChatEvent } from './useDashboardChat.js';

/** Page context — tells the agent what the user is currently looking at. */
export interface PageContext {
  /** e.g., "dashboard", "investigation", "alerts", "home" */
  kind: string;
  /** Resource ID (dashboardId, investigationId, etc.) */
  id?: string;
  /** Selected time range on the dashboard (e.g., "1h", "6h", "24h", "7d") */
  timeRange?: string;
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
  /** Current session ID (readonly). */
  currentSessionId: string;
  /** Clear messages/events, generate a new sessionId, persist to localStorage. */
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
function payloadToChatEvent(
  id: string,
  kind: string,
  payload: Record<string, unknown>,
): ChatEvent | null {
  switch (kind) {
    case 'thinking':
      return { id, kind: 'thinking', content: (payload.content as string) ?? 'Thinking...' };
    case 'tool_call':
      return {
        id,
        kind: 'tool_call',
        tool: payload.tool as string | undefined,
        content: (payload.displayText as string) ?? (payload.content as string) ?? '',
      };
    case 'tool_result':
      return {
        id,
        kind: 'tool_result',
        tool: payload.tool as string | undefined,
        content: (payload.summary as string) ?? (payload.content as string) ?? '',
        success: payload.success !== false,
      };
    case 'panel_added':
      return { id, kind: 'panel_added', panel: payload.panel as ChatEvent['panel'] };
    case 'panel_removed':
      return { id, kind: 'panel_removed', panelId: payload.panelId as string | undefined };
    case 'panel_modified':
      return { id, kind: 'panel_modified', panelId: payload.panelId as string | undefined };
    case 'error':
      return {
        id,
        kind: 'error',
        content:
          (payload.message as string) ?? (payload.content as string) ?? 'An error occurred',
      };
    default:
      // Kinds we intentionally don't replay: variable_added / investigation_report
      // are reflected in dashboard state, not chat history; agent_event /
      // verification_report / approval_required aren't currently rendered.
      return null;
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
  const [pendingNavigation, setPendingNavigation] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<'not-found' | 'network' | null>(null);
  const lastLoadSessionIdRef = useRef<string | null>(null);
  // Monotonic token bumped on every loadSession() call. A stale completion
  // (slow network) checks this against its captured token and bails if a
  // newer load has started — otherwise it would clobber the fresher session's
  // messages with whatever the older request returned.
  const loadTokenRef = useRef(0);
  const pageContextRef = useRef<PageContext | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const [currentSessionId, setCurrentSessionId] = useState<string>(
    () => localStorage.getItem('chat_session_id') ?? `ses_${crypto.randomUUID()}`,
  );
  const sessionIdRef = useRef<string>(currentSessionId);

  // Keep ref in sync with state
  useEffect(() => {
    sessionIdRef.current = currentSessionId;
    localStorage.setItem('chat_session_id', currentSessionId);
  }, [currentSessionId]);

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
            content: (parsed.displayText as string) ?? (parsed.content as string) ?? '',
          });
          break;
        }

        case 'tool_result': {
          appendEvent({
            id,
            kind: 'tool_result',
            tool: parsed.tool as string | undefined,
            content: (parsed.summary as string) ?? (parsed.content as string) ?? '',
            success: parsed.success !== false,
          });
          break;
        }

        case 'panel_added': {
          appendEvent({ id, kind: 'panel_added', panel: parsed.panel as ChatEvent['panel'] });
          break;
        }

        case 'panel_removed': {
          appendEvent({ id, kind: 'panel_removed', panelId: parsed.panelId as string | undefined });
          break;
        }

        case 'panel_modified': {
          appendEvent({ id, kind: 'panel_modified', panelId: parsed.panelId as string | undefined });
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

        case 'done': {
          // Check if done carries a navigate directive as well
          const navigateTo = parsed.navigate as string | undefined;
          if (navigateTo) {
            setPendingNavigation(navigateTo);
          }
          appendEvent({ id, kind: 'done', content: 'Generation complete' });
          break;
        }

        case 'error': {
          const content =
            (parsed.message as string) ?? (parsed.content as string) ?? 'An error occurred';
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
        await apiClient.postStream(
          '/chat',
          {
            message: content,
            sessionId: sessionIdRef.current,
            ...(pageContextRef.current ? { pageContext: pageContextRef.current } : {}),
          },
          handleSSEEvent,
          abortRef.current.signal,
        );
        // A successful round-trip means the session is reachable — drop any
        // stale loadError banner so it doesn't linger after a transient blip.
        setLoadError(null);
      } catch (err) {
        if (err instanceof Error && err.name !== 'AbortError') {
          const id = crypto.randomUUID();
          // Provide a friendlier message when the endpoint doesn't exist yet
          const is404 = err.message.includes('404');
          appendEvent({
            id,
            kind: 'error',
            content: is404
              ? 'The /api/chat endpoint is not available yet. The backend team is still working on it.'
              : err.message,
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
    const newId = `ses_${crypto.randomUUID()}`;
    setCurrentSessionId(newId);
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
        events?: Array<{ id: string; seq: number; kind: string; payload: Record<string, unknown>; timestamp: string }>;
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
        const errStatus = Number((res.error as unknown as Record<string, unknown>).status);
        const code = res.error.code ?? '';
        const msg = res.error.message ?? '';
        const is404 =
          errStatus === 404 ||
          code === 'NOT_FOUND' ||
          /not\s*found/i.test(msg);
        console.error('[useChat] loadSession failed', { sessionId, error: res.error });
        setLoadError(is404 ? 'not-found' : 'network');
        return;
      }

      if (!res.data?.messages) {
        // Empty success — treat as a successful load of an empty session.
        return;
      }

      const loaded = res.data.messages;
      setMessages(loaded);

      // Rebuild the full event trace so the chat panel looks identical to the
      // live run: messages interleaved with the agent-activity events they
      // produced (tool_call / tool_result / panel_added / thinking / etc.).
      // Strategy: turn each message + each persisted step event into a
      // timestamped entry, sort chronologically, then convert to ChatEvents.
      type Entry =
        | { kind: 'msg'; ts: string; message: ChatMessage }
        | { kind: 'evt'; ts: string; seq: number; id: string; evt: ChatEvent };

      const entries: Entry[] = [];
      for (const msg of loaded) {
        entries.push({ kind: 'msg', ts: msg.timestamp, message: msg });
      }
      for (const raw of res.data.events ?? []) {
        const evt = payloadToChatEvent(raw.id, raw.kind, raw.payload);
        if (evt) entries.push({ kind: 'evt', ts: raw.timestamp, seq: raw.seq, id: raw.id, evt });
      }
      entries.sort((a, b) => {
        if (a.ts !== b.ts) return a.ts < b.ts ? -1 : 1;
        // Same timestamp: events use seq for ordering; messages come before
        // any same-timestamp events to match the live-stream order (user
        // message appended, then agent activity begins).
        const aSeq = a.kind === 'evt' ? a.seq : -Infinity;
        const bSeq = b.kind === 'evt' ? b.seq : -Infinity;
        return aSeq - bSeq;
      });

      const rebuilt: ChatEvent[] = entries.map((e) =>
        e.kind === 'msg'
          ? { id: e.message.id, kind: 'message', message: e.message }
          : e.evt,
      );
      setEvents(rebuilt);
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
