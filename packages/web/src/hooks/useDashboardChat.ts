import { useState, useCallback, useRef, useEffect, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { apiClient } from '../api/client.js';
import type { PanelConfig } from '../components/DashboardPanelCard.js';

// Types

export interface DashboardVariable {
  name: string;
  label?: string;
  type: 'query' | 'custom' | 'constant';
  query?: string;
  options?: string[];
  current?: string;
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp: string;
}

export type ChatEventKind =
  | 'message'
  | 'thinking'
  | 'tool_call'
  | 'tool_result'
  | 'panel_added'
  | 'panel_removed'
  | 'panel_modified'
  | 'variable_added'
  | 'investigation_report'
  | 'done'
  | 'error';

export interface InvestigationReportSection {
  type: 'text' | 'evidence';
  content?: string;
  panel?: PanelConfig;
}

export interface InvestigationReport {
  summary: string;
  sections: InvestigationReportSection[];
}

export interface ChatEvent {
  id: string;
  kind: ChatEventKind;
  // For "message" the full message object
  message?: ChatMessage;
  // For tool events
  tool?: string;
  content?: string;
  success?: boolean;
  // For panel events
  panel?: PanelConfig;
  panelId?: string;
  // For variable events
  variable?: DashboardVariable;
  // For investigation report
  investigationReport?: InvestigationReport;
}

interface UseDashboardChatResult {
  messages: ChatMessage[];
  events: ChatEvent[];
  isGenerating: boolean;
  sendMessage: (content: string) => Promise<void>;
  stopGeneration: () => void;
  panels: PanelConfig[];
  variables: DashboardVariable[];
  setPanels: React.Dispatch<React.SetStateAction<PanelConfig[]>>;
  setVariables: React.Dispatch<React.SetStateAction<DashboardVariable[]>>;
  investigationReport: InvestigationReport | null;
}

interface ChatTimeRange {
  start: string;
  end: string;
  timezone?: string;
}

function resolveChatTimeRange(range: string): ChatTimeRange {
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const end = new Date();
  let ms = 30 * 60 * 1000;
  const match = range.match(/^(\d+)(m|h|d)$/);
  if (match) {
    const [, n, unit] = match;
    const num = parseInt(n ?? '30', 10);
    if (unit === 'm') ms = num * 60 * 1000;
    else if (unit === 'h') ms = num * 3600 * 1000;
    else if (unit === 'd') ms = num * 86400 * 1000;
  } else if (range.includes('|')) {
    const parts = range.split('|');
    const startDate = new Date(parts[0] ?? '');
    const endDate = new Date(parts[1] ?? '');
    if (!Number.isNaN(startDate.getTime()) && !Number.isNaN(endDate.getTime())) {
      return { start: startDate.toISOString(), end: endDate.toISOString(), timezone };
    }
  }
  return { start: new Date(end.getTime() - ms).toISOString(), end: end.toISOString(), timezone };
}

// Hook
export function useDashboardChat(
  dashboardId: string,
  initialPanels: PanelConfig[],
  initialVariables: DashboardVariable[] = [],
  timeRange = '1h',
  sessionId?: string,
): UseDashboardChatResult {
  const navigate = useNavigate();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [investigationReport, setInvestigationReport] = useState<InvestigationReport | null>(null);
  const [events, setEvents] = useState<ChatEvent[]>([]);
  const [isGenerating, setIsGenerating] = useState(false);
  const [panels, setPanels] = useState<PanelConfig[]>(initialPanels);
  const [variables, setVariables] = useState<DashboardVariable[]>(initialVariables);
  const abortRef = useRef<AbortController | null>(null);
  const historyLoadedRef = useRef(false);

  // Track whether SSE has modified panels during this generation cycle
  const sseModifiedRef = useRef(false);

  // Reset SSE-modified flag when generation starts
  useEffect(() => {
    if (isGenerating) {
      sseModifiedRef.current = false;
    }
  }, [isGenerating]);

  // Sync panels when initialPanels changes (e.g. initial load),
  // but NOT during generation when SSE is the authoritative source
  useEffect(() => {
    if (!isGenerating && !sseModifiedRef.current) {
      setPanels(initialPanels);
    }
  }, [initialPanels, isGenerating]);

  // Load chat history from the chat-service session messages endpoint on
  // mount / dashboard change. Without a sessionId there is no history to load,
  // so the hook initializes empty messages/events for the new dashboard.
  useEffect(() => {
    if (!dashboardId) return;
    historyLoadedRef.current = false;
    setMessages([]);
    setEvents([]);
    setInvestigationReport(null);
    let cancelled = false;
    void (async () => {
      const chatPromise = sessionId
        ? apiClient.get<{ messages: ChatMessage[] }>(`/chat/sessions/${sessionId}/messages`)
        : Promise.resolve({ data: { messages: [] }, error: null } as { data: { messages: ChatMessage[] } | null; error: null | { code: string; message?: string } });
      const chatRes = await chatPromise;
      if (cancelled) return;
      const loadedMessages = chatRes.data?.messages ?? [];
      if (loadedMessages.length) {
        setMessages(loadedMessages);
        setEvents((prev) => {
          // If events were already added (e.g. initial prompt), prepend history before them
          if (prev.length > 0) {
            const existingIds = new Set(prev.map((e) => e.id));
            const historyEvents = loadedMessages
              .filter((m) => !existingIds.has(m.id))
              .map((m) => ({ id: m.id, kind: 'message' as const, message: m }));
            return [...historyEvents, ...prev];
          }
          return loadedMessages.map((m) => ({
            id: m.id,
            kind: 'message' as const,
            message: m,
          }));
        });
      }
      historyLoadedRef.current = true;
    })();
    return () => {
      cancelled = true;
    };
  }, [dashboardId, sessionId]);

  const appendEvent = useCallback((evt: ChatEvent) => {
    setEvents((prev) => [...prev, evt]);
  }, []);

  const handleSSEEvent = useCallback(
    (eventType: string, rawData: string) => {
      let parsed: Record<string, unknown> = {};
      try {
        parsed = JSON.parse(rawData) as Record<string, unknown>;
      } catch {
        // If not JSON, treat as plain text content
        parsed = { content: rawData };
      }

      // Use parsed.type as fallback when SSE event type is generic 'message'
      const resolvedType = (eventType === 'message' && typeof parsed.type === 'string')
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
          const panel = parsed.panel as PanelConfig | undefined;
          if (panel) {
            sseModifiedRef.current = true;
            setPanels((prev) => {
              if (prev.find((p) => p.id === panel.id)) return prev;
              return [...prev, panel];
            });
            appendEvent({ id, kind: 'panel_added', panel });
          }
          break;
        }

        case 'panel_removed': {
          const panelId = parsed.panelId as string | undefined;
          if (panelId) {
            sseModifiedRef.current = true;
            setPanels((prev) => prev.filter((p) => p.id !== panelId));
            appendEvent({ id, kind: 'panel_removed', panelId });
          }
          break;
        }

        case 'panel_modified': {
          const panelId = parsed.panelId as string | undefined;
          const patch = (parsed.patch ?? parsed.panel) as Partial<PanelConfig> | undefined;
          if (panelId && patch) {
            sseModifiedRef.current = true;
            setPanels((prev =>
              prev.map((p) => (p.id === panelId ? { ...p, ...patch } : p))
            ));
            appendEvent({ id, kind: 'panel_modified', panelId });
          }
          break;
        }

        case 'variable_added': {
          const variable = parsed.variable as DashboardVariable | undefined;
          if (variable) {
            setVariables((prev => {
              if (prev.find((v) => v.name === variable.name)) return prev;
              return [...prev, variable];
            }));
            appendEvent({ id, kind: 'variable_added', variable });
          }
          break;
        }

        case 'investigation_report': {
          const report = parsed.report as InvestigationReport | undefined;
          if (report) {
            setInvestigationReport(report);
            appendEvent({ id, kind: 'investigation_report', investigationReport: report });
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
          const navigateTo = parsed.navigate as string | undefined;
          if (navigateTo && navigateTo !== `/dashboards/${dashboardId}`) {
            navigate(navigateTo);
            break;
          }
          appendEvent({ id, kind: 'done', content: 'Generation complete' });
          break;
        }

        case 'error': {
          const content = (parsed.message as string) ?? (parsed.content as string) ?? 'An error occurred';
          appendEvent({ id, kind: 'error', content });
          break;
        }

        default:
          break;
      }
    },
    [appendEvent, dashboardId, navigate],
  );

  const sendMessage = useCallback(
    async (content: string) => {
      if (!content.trim() || isGenerating) return;

      // Abort any in-flight stream
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
        // Route through the canonical chat-service endpoint. The dashboard is
        // identified through `pageContext` so the orchestrator scopes its
        // dashboard.* tools to it; the legacy POST /api/dashboards/:id/chat
        // path was removed.
        const tr = resolveChatTimeRange(timeRange);
        await apiClient.postStream(
          `/chat`,
          {
            message: content,
            ...(sessionId ? { sessionId } : {}),
            pageContext: { kind: 'dashboard', id: dashboardId, timeRange },
            timeRange: tr,
          },
          handleSSEEvent,
          abortRef.current.signal,
        );
      } catch (err) {
        if (err instanceof Error && err.name !== 'AbortError') {
          const id = crypto.randomUUID();
          appendEvent({ id, kind: 'error', content: err.message });
        }
      } finally {
        setIsGenerating(false);
      }
    },
    [dashboardId, sessionId, isGenerating, handleSSEEvent, appendEvent, timeRange],
  );

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
      panels,
      variables,
      setPanels,
      setVariables,
      investigationReport,
    }),
    [
      messages,
      events,
      isGenerating,
      sendMessage,
      stopGeneration,
      panels,
      variables,
      setPanels,
      setVariables,
      investigationReport,
    ],
  );
}
