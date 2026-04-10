import React, { useEffect, useState, useCallback, useMemo } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { apiClient } from '../api/client.js';
import InvestigationReportView from '../components/InvestigationReportView.js';
import type { ConclusionData } from '../components/ConclusionPanel.js';
import ChatPanel from '../components/ChatPanel.js';
import type { ChatEvent } from '../hooks/useDashboardChat.js';
import type { InvestigationReport as IReport, InvestigationReportSection } from '../hooks/useDashboardChat.js';
import type { Evidence } from '@agentic-obs/common';
import type { InvestigationStatus } from '../api/types.js';
import { relativeTime } from '../utils/time.js';

// Types

interface InvestigationStep {
  id: string;
  type: string;
  description: string;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'skipped';
}

interface InvestigationPlan {
  entity: string;
  objective: string;
  steps: InvestigationStep[];
}

interface Hypothesis {
  id: string;
  description: string;
  confidence: number;
  status: string;
}

interface FullInvestigation {
  id: string;
  intent: string;
  sessionId: string;
  status: InvestigationStatus;
  plan: InvestigationPlan;
  hypotheses: Hypothesis[];
  evidence: Evidence[];
  createdAt: string;
  updatedAt: string;
}

// Helpers

function isTerminal(status: string) {
  return status === 'completed' || status === 'failed';
}

const STATUS_LABELS: Record<string, string> = {
  planning: 'Planning investigation steps...',
  investigating: 'Querying data sources...',
  evidencing: 'Collecting evidence...',
  explaining: 'Analyzing findings...',
  acting: 'Determining actions...',
  verifying: 'Verifying results...',
  completed: 'Investigation complete',
  failed: 'Investigation failed',
};

let eventCounter = 0;
function makeEventId() { return `inv_evt_${++eventCounter}`; }

// Convert investigation state changes into ChatEvents for the ChatPanel

function buildChatEvents(investigation: FullInvestigation, conclusion: ConclusionData | null): ChatEvent[] {
  const events: ChatEvent[] = [];

  // Initial user message — the investigation question
  events.push({
    id: makeEventId(),
    kind: 'message',
    message: {
      id: 'user_0',
      role: 'user',
      content: investigation.intent,
      timestamp: investigation.createdAt,
    },
  });

  // Planning phase
  if (investigation.plan?.objective) {
    events.push({
      id: makeEventId(),
      kind: 'thinking',
      content: `Planning: ${investigation.plan.objective}`,
    });
  }

  // Plan steps as tool calls
  if (investigation.plan?.steps?.length) {
    for (const step of investigation.plan.steps) {
      if (step.status === 'pending') continue;

      events.push({
        id: makeEventId(),
        kind: 'tool_call',
        tool: step.type || 'query',
        content: step.description,
      });

      if (step.status === 'completed') {
        events.push({
          id: makeEventId(),
          kind: 'tool_result',
          tool: step.type || 'query',
          content: `Step completed: ${step.description}`,
          success: true,
        });
      } else if (step.status === 'failed') {
        events.push({
          id: makeEventId(),
          kind: 'tool_result',
          tool: step.type || 'query',
          content: `Step failed: ${step.description}`,
          success: false,
        });
      }
    }
  }

  // Evidence collected
  if (investigation.evidence?.length > 0) {
    events.push({
      id: makeEventId(),
      kind: 'thinking',
      content: `Collected ${investigation.evidence.length} piece${investigation.evidence.length > 1 ? 's' : ''} of evidence`,
    });
  }

  // Analysis / status update
  if (investigation.status === 'explaining' || investigation.status === 'acting' || investigation.status === 'verifying') {
    events.push({
      id: makeEventId(),
      kind: 'thinking',
      content: STATUS_LABELS[investigation.status] ?? 'Processing...',
    });
  }

  // Conclusion as assistant message
  if (conclusion) {
    let msg = conclusion.summary;
    if (conclusion.rootCause) {
      msg += `\n\n**Root Cause:** ${conclusion.rootCause}`;
    }
    if (conclusion.recommendedActions?.length) {
      msg += '\n\n**Recommended Actions:**\n' + conclusion.recommendedActions.map((a) => `- ${typeof a === 'string' ? a : a.label}`).join('\n');
    }
    events.push({
      id: makeEventId(),
      kind: 'message',
      message: {
        id: 'conclusion',
        role: 'assistant',
        content: msg,
        timestamp: investigation.updatedAt,
      },
    });
  } else if (investigation.status === 'failed') {
    events.push({
      id: makeEventId(),
      kind: 'error',
      content: 'Investigation failed. The AI could not complete the analysis.',
    });
  }

  // Done event if terminal
  if (isTerminal(investigation.status)) {
    events.push({ id: makeEventId(), kind: 'done' });
  }

  return events;
}


// Live progress view while investigation is running

function LiveProgressView({ investigation }: { investigation: FullInvestigation }) {
  return (
    <div className="px-12 py-10 max-w-4xl mx-auto space-y-8">
      <header className="space-y-4">
        <span className="px-2 py-0.5 rounded bg-primary/10 text-primary text-[10px] font-bold tracking-widest uppercase">
          Investigation In Progress
        </span>
        <h1 className="text-3xl font-extrabold font-[Manrope] tracking-tight text-on-surface leading-tight">
          {investigation.intent}
        </h1>
      </header>


      {/* Plan objective */}
      {investigation.plan?.objective && (
        <section>
          <h3 className="text-xl font-bold font-[Manrope] text-on-surface flex items-center gap-2 mb-3">
            <span className="w-1.5 h-6 bg-primary rounded-full" />
            Objective
          </h3>
          <p className="text-[15px] text-on-surface-variant leading-relaxed pl-4 border-l-2 border-primary/40">
            {investigation.plan.objective}
          </p>
        </section>
      )}

      {/* Plan steps */}
      {investigation.plan?.steps?.length > 0 && (
        <section>
          <h3 className="text-xl font-bold font-[Manrope] text-on-surface flex items-center gap-2 mb-3">
            <span className="w-1.5 h-6 bg-primary rounded-full" />
            Steps
          </h3>
          <div className="space-y-2 pl-4">
            {investigation.plan.steps.map((step, i) => (
              <div key={step.id || i} className="flex items-start gap-3 py-1">
                <span className="mt-1 shrink-0">
                  {step.status === 'completed' ? (
                    <svg className="w-4 h-4 text-emerald-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}><path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" /></svg>
                  ) : step.status === 'running' ? (
                    <span className="w-4 h-4 flex items-center justify-center"><span className="w-2.5 h-2.5 rounded-full bg-amber-400 animate-pulse" /></span>
                  ) : step.status === 'failed' ? (
                    <svg className="w-4 h-4 text-red-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" /></svg>
                  ) : (
                    <span className="w-4 h-4 rounded-full border-2 border-outline-variant block" />
                  )}
                </span>
                <p className={`text-[15px] leading-relaxed ${step.status === 'skipped' ? 'text-outline line-through' : 'text-on-surface-variant'}`}>
                  {step.description}
                </p>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Evidence count while running */}
      {investigation.evidence?.length > 0 && (
        <section>
          <h3 className="text-xl font-bold font-[Manrope] text-on-surface flex items-center gap-2 mb-3">
            <span className="w-1.5 h-6 bg-primary rounded-full" />
            Evidence Collected
          </h3>
          <p className="text-[15px] text-on-surface-variant pl-4 border-l-2 border-primary/40">
            {investigation.evidence.length} data point{investigation.evidence.length > 1 ? 's' : ''} collected so far...
          </p>
        </section>
      )}

      {/* Waiting spinner when no steps yet */}
      {!investigation.plan?.steps?.length && (
        <div className="flex flex-col items-center justify-center py-12 text-center">
          <span className="inline-block w-8 h-8 border-2 border-outline-variant border-t-primary rounded-full animate-spin mb-4" />
          <p className="text-sm text-on-surface-variant">{STATUS_LABELS[investigation.status] ?? 'Working...'}</p>
        </div>
      )}
    </div>
  );
}

// Main

export default function InvestigationDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [investigation, setInvestigation] = useState<FullInvestigation | null>(null);
  const [conclusion, setConclusion] = useState<ConclusionData | null>(null);
  const [report, setReport] = useState<IReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [agentEvents, setAgentEvents] = useState<ChatEvent[]>([]);
  const [agentGenerating, setAgentGenerating] = useState(false);

  const fetchInvestigation = useCallback(async () => {
    if (!id) return;
    const res = await apiClient.get<FullInvestigation>(`/investigations/${id}`);
    if (res.error) {
      setError(res.error.message ?? 'Investigation not found');
      setLoading(false);
      return;
    }
    setInvestigation(res.data);
    setLoading(false);

    if (res.data.status === 'completed' || res.data.status === 'failed') {
      // Fetch the LLM-generated report
      const rRes = await apiClient.get<{ summary: string; sections: InvestigationReportSection[] }>(`/investigations/${id}/report`);
      if (!rRes.error && rRes.data?.summary) {
        setReport({ summary: rRes.data.summary, sections: rRes.data.sections });
      }
      // Fetch conclusion for chat panel
      const cRes = await apiClient.get<{ conclusion: ConclusionData }>(`/investigations/${id}/conclusion`);
      if (!cRes.error && cRes.data?.conclusion) {
        setConclusion(cRes.data.conclusion);
      }
    }
  }, [id]);

  useEffect(() => { void fetchInvestigation(); }, [fetchInvestigation]);

  // Poll while investigation is active
  useEffect(() => {
    if (!investigation || isTerminal(investigation.status)) return;
    const timer = setInterval(() => void fetchInvestigation(), 3000);
    return () => clearInterval(timer);
  }, [investigation, fetchInvestigation]);

  // Build chat events from investigation state
  const baseChatEvents = useMemo(() => {
    if (!investigation) return [];
    eventCounter = 0;
    return buildChatEvents(investigation, conclusion);
  }, [investigation, conclusion]);

  const chatEvents = useMemo(() => [...baseChatEvents, ...agentEvents], [baseChatEvents, agentEvents]);

  const isGenerating = (investigation ? !isTerminal(investigation.status) : false) || agentGenerating;

  // Handle follow-up messages from ChatPanel
  const handleSendMessage = useCallback(async (content: string) => {
    if (!id) return;
    const userEventId = crypto.randomUUID();
    setAgentEvents((prev) => [
      ...prev,
      {
        id: userEventId,
        kind: 'message',
        message: {
          id: userEventId,
          role: 'user',
          content,
          timestamp: new Date().toISOString(),
        },
      },
    ]);
    setAgentGenerating(true);

    await apiClient.postStream(
      '/agent/chat',
      {
        message: content,
        sessionId: investigation?.sessionId ?? `ses_inv_${id}`,
        context: { kind: 'investigation', id },
      },
      (eventType: string, rawData: string) => {
        let parsed: Record<string, unknown> = {};
        try {
          parsed = JSON.parse(rawData) as Record<string, unknown>;
        } catch {
          parsed = { content: rawData };
        }

        const eventId = crypto.randomUUID();

        if (eventType === 'thinking') {
          setAgentEvents((prev) => [
            ...prev,
            {
              id: eventId,
              kind: 'thinking',
              content: (parsed.content as string) ?? 'Thinking...',
            },
          ]);
          return;
        }

        if (eventType === 'reply') {
          setAgentEvents((prev) => [
            ...prev,
            {
              id: eventId,
              kind: 'message',
              message: {
                id: eventId,
                role: 'assistant',
                content: (parsed.content as string) ?? '',
                timestamp: new Date().toISOString(),
              },
            },
          ]);
          return;
        }

        if (eventType === 'error') {
          setAgentEvents((prev) => [
            ...prev,
            {
              id: eventId,
              kind: 'error',
              content: (parsed.message as string) ?? 'Something went wrong',
            },
          ]);
          setAgentGenerating(false);
          return;
        }

        if (eventType === 'done') {
          if (typeof parsed.navigate === 'string' && parsed.navigate !== `/investigations/${id}`) {
            if (parsed.intent === 'dashboard') {
              navigate(parsed.navigate, { state: { initialPrompt: content } });
            } else {
              navigate(parsed.navigate);
            }
            return;
          }
          setAgentEvents((prev) => [...prev, { id: eventId, kind: 'done' }]);
          setAgentGenerating(false);
        }
      },
    ).catch((err) => {
      const message = err instanceof Error ? err.message : 'Network error';
      setAgentEvents((prev) => [
        ...prev,
        {
          id: crypto.randomUUID(),
          kind: 'error',
          content: message,
        },
      ]);
      setAgentGenerating(false);
    }).finally(() => {
      setAgentGenerating(false);
    });
  }, [id, investigation?.sessionId, navigate]);

  if (loading) {
    return (
      <div className="h-full flex items-center justify-center">
        <span className="inline-block w-6 h-6 border-2 border-outline-variant border-t-primary rounded-full animate-spin" />
      </div>
    );
  }

  if (error || !investigation) {
    return (
      <div className="h-full flex flex-col items-center justify-center gap-3">
        <p className="text-sm text-red-400">{error ?? 'Investigation not found'}</p>
        <button type="button" onClick={() => navigate('/investigations')} className="text-sm text-primary hover:underline">
          Back to Investigations
        </button>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-[100vh] overflow-hidden">
      {/* Header */}
      <div className="shrink-0 flex items-center gap-3 px-6 py-2.5 border-b border-outline-variant/20">
        <button
          type="button"
          onClick={() => navigate('/investigations')}
          className="p-1.5 rounded-lg text-on-surface-variant hover:text-on-surface hover:bg-surface-high transition-colors"
          title="Back to investigations"
        >
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
          </svg>
        </button>

        <div className="flex-1 min-w-0">
          <h1 className="text-sm font-semibold text-on-surface truncate">{investigation.intent}</h1>
          <div className="flex items-center gap-2">
            <span className="text-[11px] text-on-surface-variant">{relativeTime(investigation.createdAt)}</span>
            {investigation.plan?.entity && (
              <span className="px-1.5 py-0.5 rounded bg-surface-high text-on-surface-variant text-[10px] font-mono">
                {investigation.plan.entity}
              </span>
            )}
          </div>
        </div>

        {/* Status badge */}
        <div className={`flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium ${
          isGenerating
            ? 'bg-primary/10 text-primary'
            : investigation.status === 'completed'
            ? 'bg-emerald-500/15 text-emerald-400'
            : 'bg-red-500/15 text-red-400'
        }`}>
          {isGenerating && <span className="w-1.5 h-1.5 rounded-full bg-primary animate-pulse" />}
          {STATUS_LABELS[investigation.status] ?? investigation.status}
        </div>
      </div>

      {/* Content + Chat split — same layout as DashboardWorkspace */}
      <div className="flex-1 flex overflow-hidden">
        {/* Left: Report (complete) or live progress (running) */}
        <div className="flex-1 flex flex-col min-w-0">
          {report ? (
            <InvestigationReportView report={report} title={investigation.intent} />
          ) : (
            <div className="flex-1 overflow-y-auto overscroll-contain bg-surface-container">
              <LiveProgressView investigation={investigation} />
            </div>
          )}

          <div className="shrink-0 px-6 py-2 flex items-center gap-2">
            <span className={`w-1.5 h-1.5 rounded-full ${isGenerating ? 'bg-primary animate-pulse' : investigation.status === 'completed' ? 'bg-secondary' : 'bg-red-400'}`} />
            <span className="text-xs text-on-surface-variant">
              {isGenerating
                ? STATUS_LABELS[investigation.status]
                : investigation.status === 'completed'
                ? `${investigation.evidence?.length ?? 0} evidence · ${investigation.hypotheses?.length ?? 0} hypotheses`
                : 'Failed'
              }
            </span>
          </div>
        </div>

        {/* Right: Chat panel */}
        <ChatPanel
          events={chatEvents}
          isGenerating={isGenerating}
          onSendMessage={(msg) => { void handleSendMessage(msg); }}
        />
      </div>
    </div>
  );
}
