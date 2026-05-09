import { useState, useCallback, useRef, useEffect, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import type { Provenance } from '@agentic-obs/common';
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
  | 'pending_changes_proposed'
  | 'investigation_report'
  | 'ask_user'
  | 'ds_choice'
  | 'done'
  | 'error';

export interface AskUserOption {
  id: string;
  label: string;
  hint?: string;
}

export interface DatasourceChoiceAlternative {
  id: string;
  name: string;
  environment?: string;
  cluster?: string;
}

/**
 * Parse an SSE `ask_user` payload into a strongly-typed option list.
 * Exported for unit tests so the parser can be exercised without mounting
 * the hook. Drops malformed entries (missing id/label, wrong types) so the
 * UI never has to render half-built buttons.
 */
export function parseAskUserPayload(
  payload: Record<string, unknown>,
): { question: string; options: AskUserOption[] } {
  const question = typeof payload.question === 'string' ? payload.question : '';
  const rawOptions = Array.isArray(payload.options) ? payload.options : [];
  const options: AskUserOption[] = rawOptions
    .map((o) => {
      if (!o || typeof o !== 'object') return null;
      const obj = o as Record<string, unknown>;
      const id = typeof obj.id === 'string' ? obj.id : '';
      const label = typeof obj.label === 'string' ? obj.label : '';
      if (!id || !label) return null;
      const hint = typeof obj.hint === 'string' ? obj.hint : undefined;
      return hint ? { id, label, hint } : { id, label };
    })
    .filter((o): o is AskUserOption => o !== null);
  return { question, options };
}

export interface InvestigationReportSection {
  type: 'text' | 'evidence';
  content?: string;
  panel?: PanelConfig;
}

export interface InvestigationReport {
  summary: string;
  sections: InvestigationReportSection[];
  /** Optional provenance metadata; when present the <ProvenanceHeader /> shows
   *  model / runId / tool-call count / cost / latency for this report. */
  provenance?: Provenance;
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
  // For 'pending_changes_proposed' — Task 09 batch of proposals for review.
  pendingChanges?: Array<{
    id: string;
    proposedAt: string;
    proposedBy: string;
    sessionId?: string;
    summary: string;
    op: Record<string, unknown>;
  }>;
  dashboardId?: string;
  // For investigation report
  investigationReport?: InvestigationReport;
  // For "ask_user" — the question + clickable option buttons
  question?: string;
  options?: AskUserOption[];
  // For "ds_choice" — agent's inline narration of which datasource it picked
  chosenId?: string;
  chosenName?: string;
  chooseReason?: string;
  confidence?: 'high' | 'medium' | 'low';
  alternatives?: DatasourceChoiceAlternative[];
  // For tool_call/tool_result — optional payload for expandable step cards.
  // All fields are graceful-absent: server may not yet emit them.
  params?: Record<string, unknown>;
  output?: string;
  evidenceId?: string;
  cost?: number;
  durationMs?: number;
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
): UseDashboardChatResult {
  const navigate = useNavigate();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [investigationReport, setInvestigationReport] = useState<InvestigationReport | null>(null);
  const [events, setEvents] = useState<ChatEvent[]>([]);
  const [isGenerating, setIsGenerating] = useState(false);
  const [panels, setPanels] = useState<PanelConfig[]>(initialPanels);
  const [variables, setVariables] = useState<DashboardVariable[]>(initialVariables);
  const abortRef = useRef<AbortController | null>(null);

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

  // Resource pages do not own chat history. The global personal chat loads
  // history from `?chat=...`; this hook only tracks the live dashboard stream.
  useEffect(() => {
    if (!dashboardId) return;
    setMessages([]);
    setEvents([]);
    setInvestigationReport(null);
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
          const params =
            parsed.args && typeof parsed.args === 'object' && !Array.isArray(parsed.args)
              ? (parsed.args as Record<string, unknown>)
              : undefined;
          appendEvent({
            id,
            kind: 'tool_call',
            tool: parsed.tool as string | undefined,
            content: (parsed.displayText as string) ?? (parsed.content as string) ?? '',
            ...(params ? { params } : {}),
            ...(typeof parsed.evidenceId === 'string' ? { evidenceId: parsed.evidenceId } : {}),
          });
          break;
        }

        case 'tool_result': {
          const summary = (parsed.summary as string) ?? (parsed.content as string) ?? '';
          const output = typeof parsed.output === 'string' ? parsed.output : undefined;
          appendEvent({
            id,
            kind: 'tool_result',
            tool: parsed.tool as string | undefined,
            content: summary,
            success: parsed.success !== false,
            ...(output ? { output } : {}),
            ...(typeof parsed.evidenceId === 'string' ? { evidenceId: parsed.evidenceId } : {}),
            ...(typeof parsed.cost === 'number' ? { cost: parsed.cost } : {}),
            ...(typeof parsed.durationMs === 'number' ? { durationMs: parsed.durationMs } : {}),
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

        case 'pending_changes_proposed': {
          // Task 09 — agent proposed modifications to a pre-existing dashboard.
          // The page subscribes to this event kind to update its review bar.
          const dashboardId = parsed.dashboardId as string | undefined;
          const changes = parsed.changes as ChatEvent['pendingChanges'];
          if (changes && Array.isArray(changes) && changes.length > 0) {
            appendEvent({
              id,
              kind: 'pending_changes_proposed',
              dashboardId,
              pendingChanges: changes,
            });
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

        case 'ask_user': {
          const { question, options } = parseAskUserPayload(parsed);
          appendEvent({ id, kind: 'ask_user', question, options });
          break;
        }

        case 'ds_choice': {
          const chosenId = typeof parsed.chosenId === 'string' ? parsed.chosenId : '';
          const chosenName = typeof parsed.name === 'string' ? parsed.name : '';
          const chooseReason = typeof parsed.reason === 'string' ? parsed.reason : '';
          const confidence = (parsed.confidence === 'high' || parsed.confidence === 'medium' || parsed.confidence === 'low')
            ? parsed.confidence
            : 'low';
          const rawAlts = Array.isArray(parsed.alternatives) ? parsed.alternatives : [];
          const alternatives: DatasourceChoiceAlternative[] = rawAlts
            .map((a) => {
              if (!a || typeof a !== 'object') return null;
              const obj = a as Record<string, unknown>;
              const aid = typeof obj.id === 'string' ? obj.id : '';
              const name = typeof obj.name === 'string' ? obj.name : '';
              if (!aid || !name) return null;
              const env = typeof obj.environment === 'string' ? obj.environment : undefined;
              const cluster = typeof obj.cluster === 'string' ? obj.cluster : undefined;
              return { id: aid, name, ...(env ? { environment: env } : {}), ...(cluster ? { cluster } : {}) };
            })
            .filter((a): a is DatasourceChoiceAlternative => a !== null);
          appendEvent({ id, kind: 'ds_choice', chosenId, chosenName, chooseReason, confidence, alternatives });
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
        // Route through the canonical personal chat endpoint. The dashboard is
        // identified through page context only.
        const tr = resolveChatTimeRange(timeRange);
        await apiClient.postStream(
          `/chat`,
          {
            message: content,
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
    [dashboardId, isGenerating, handleSSEEvent, appendEvent, timeRange],
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
