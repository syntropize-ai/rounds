import { useState, useCallback, useRef, useEffect } from 'react';
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

// Hook
export function useDashboardChat(
  dashboardId: string,
  initialPanels: PanelConfig[],
  initialVariables: DashboardVariable[] = [],
): UseDashboardChatResult {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [investigationReport, setInvestigationReport] = useState<InvestigationReport | null>(null);
  const [events, setEvents] = useState<ChatEvent[]>([]);
  const [isGenerating, setIsGenerating] = useState(false);
  const [panels, setPanels] = useState<PanelConfig[]>(initialPanels);
  const [variables, setVariables] = useState<DashboardVariable[]>(initialVariables);
  const abortRef = useRef<AbortController | null>(null);
  const historyLoadedRef = useRef(false);

  // Sync panels when initialPanels changes (e.g. initial load)
  useEffect(() => {
    setPanels(initialPanels);
  }, [initialPanels]);

  // Load chat history and saved investigation report on mount / dashboard change
  useEffect(() => {
    if (!dashboardId) return;
    historyLoadedRef.current = false;
    void (async () => {
      const [chatRes, reportRes] = await Promise.all([
        apiClient.get<{ messages: ChatMessage[] }>(`/dashboards/${dashboardId}/chat`),
        apiClient.get<InvestigationReport>(`/dashboards/${dashboardId}/investigation-report`),
      ]);
      if (chatRes.data?.messages?.length) {
        setMessages(chatRes.data.messages);
        setEvents((prev) => {
          // If events were already added (e.g. initial prompt), prepend history before them
          if (prev.length > 0) {
            const existingIds = new Set(prev.map((e) => e.id));
            const historyEvents = chatRes.data.messages
              .filter((m) => !existingIds.has(m.id))
              .map((m) => ({ id: m.id, kind: 'message' as const, message: m }));
            return [...historyEvents, ...prev];
          }
          return chatRes.data.messages.map((m) => ({
            id: m.id,
            kind: 'message' as const,
            message: m,
          }));
        });
      }
      // Restore saved investigation report if one exists
      if (!reportRes.error && reportRes.data?.summary) {
        setInvestigationReport(reportRes.data);
      }
      historyLoadedRef.current = true;
    })();
  }, [dashboardId]);

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
            setPanels((prev) => prev.filter((p) => p.id !== panelId));
            appendEvent({ id, kind: 'panel_removed', panelId });
          }
          break;
        }

        case 'panel_modified': {
          const panelId = parsed.panelId as string | undefined;
          const patch = (parsed.patch ?? parsed.panel) as Partial<PanelConfig> | undefined;
          if (panelId && patch) {
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
    [appendEvent],
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
        await apiClient.postStream(
          `/dashboards/${dashboardId}/chat`,
          { message: content },
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
    [dashboardId, isGenerating, handleSSEEvent, appendEvent],
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

  return {
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
  };
}
