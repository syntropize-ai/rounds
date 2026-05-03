import React, { useEffect, useState, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { apiClient } from '../api/client.js';
import InvestigationReportView from '../components/InvestigationReportView.js';
import type {
  InvestigationReport as IReport,
  InvestigationReportSection,
} from '../hooks/useDashboardChat.js';
import type { Evidence } from '@agentic-obs/common';
import type { InvestigationStatus } from '../api/types.js';
import { relativeTime } from '../utils/time.js';
import { useGlobalChat } from '../contexts/ChatContext.js';
import InvestigationPlanBanner from '../components/plans/InvestigationPlanBanner.js';

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

import { getInvestigationStatusStyle } from '../constants/status-styles.js';

function statusDescription(status: string): string {
  return getInvestigationStatusStyle(status).description;
}

// Live progress view while investigation is running

function LiveProgressView({
  investigation,
}: {
  investigation: FullInvestigation;
}) {
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
                    <svg
                      className="w-4 h-4 text-emerald-400"
                      fill="none"
                      viewBox="0 0 24 24"
                      stroke="currentColor"
                      strokeWidth={2.5}
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        d="M5 13l4 4L19 7"
                      />
                    </svg>
                  ) : step.status === 'running' ? (
                    <span className="w-4 h-4 flex items-center justify-center">
                      <span className="w-2.5 h-2.5 rounded-full bg-amber-400 animate-pulse" />
                    </span>
                  ) : step.status === 'failed' ? (
                    <svg
                      className="w-4 h-4 text-red-400"
                      fill="none"
                      viewBox="0 0 24 24"
                      stroke="currentColor"
                      strokeWidth={2}
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        d="M6 18L18 6M6 6l12 12"
                      />
                    </svg>
                  ) : (
                    <span className="w-4 h-4 rounded-full border-2 border-outline-variant block" />
                  )}
                </span>
                <p
                  className={`text-[15px] leading-relaxed ${step.status === 'skipped' ? 'text-outline line-through' : 'text-on-surface-variant'}`}
                >
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
            {investigation.evidence.length} data point
            {investigation.evidence.length > 1 ? 's' : ''} collected so far...
          </p>
        </section>
      )}

      {/* Waiting spinner when no steps yet */}
      {!investigation.plan?.steps?.length && (
        <div className="flex flex-col items-center justify-center py-12 text-center">
          <span className="inline-block w-8 h-8 border-2 border-outline-variant border-t-primary rounded-full animate-spin mb-4" />
          <p className="text-sm text-on-surface-variant">
            {statusDescription(investigation.status)}
          </p>
        </div>
      )}
    </div>
  );
}

// Main

export default function InvestigationDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const globalChat = useGlobalChat();
  const [investigation, setInvestigation] = useState<FullInvestigation | null>(
    null,
  );
  const [report, setReport] = useState<IReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Chat history is bound by the URL (`?chat=...`) and loaded in Layout.

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
      const rRes = await apiClient.get<{
        summary: string;
        sections: InvestigationReportSection[];
      }>(`/investigations/${id}/report`);
      if (!rRes.error && rRes.data?.summary) {
        setReport({ summary: rRes.data.summary, sections: rRes.data.sections });
      }
    }
  }, [id]);

  useEffect(() => {
    void fetchInvestigation();
  }, [fetchInvestigation]);

  // Tell the global chat which investigation the user is viewing
  useEffect(() => {
    if (id) {
      globalChat.setPageContext({ kind: 'investigation', id });
    }
    return () => {
      globalChat.setPageContext(null);
    };
  }, [id, globalChat]);

  // Poll while investigation is active
  useEffect(() => {
    if (!investigation || isTerminal(investigation.status)) return;
    const timer = setInterval(() => void fetchInvestigation(), 3000);
    return () => clearInterval(timer);
  }, [investigation, fetchInvestigation]);

  const isGenerating = investigation ? !isTerminal(investigation.status) : false;

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
        <p className="text-sm text-red-400">
          {error ?? 'Investigation not found'}
        </p>
        <button
          type="button"
          onClick={() => navigate('/investigations')}
          className="text-sm text-primary hover:underline"
        >
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
          <svg
            className="w-4 h-4"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth={2}
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M15 19l-7-7 7-7"
            />
          </svg>
        </button>

        <div className="flex-1 min-w-0">
          <h1 className="text-sm font-semibold text-on-surface truncate">
            {investigation.intent}
          </h1>
          <div className="flex items-center gap-2">
            <span className="text-[11px] text-on-surface-variant">
              {relativeTime(investigation.createdAt)}
            </span>
            {investigation.plan?.entity && (
              <span className="px-1.5 py-0.5 rounded bg-surface-high text-on-surface-variant text-[10px] font-mono">
                {investigation.plan.entity}
              </span>
            )}
          </div>
        </div>

        {/* Status badge */}
        <div
          className={`flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium ${
            isGenerating
              ? 'bg-primary/10 text-primary'
              : investigation.status === 'completed'
                ? 'bg-secondary/15 text-secondary'
                : 'bg-error/15 text-error'
          }`}
        >
          {isGenerating && (
            <span className="w-1.5 h-1.5 rounded-full bg-primary animate-pulse" />
          )}
          {getInvestigationStatusStyle(investigation.status).label}
        </div>
      </div>

      {/* Remediation plan banner (auto-remediation P7) — lifted above the
          fold so operators can find approval without hunting. */}
      <InvestigationPlanBanner investigationId={investigation.id} />

      {/* Content + Chat split — same layout as DashboardWorkspace */}
      <div className="flex-1 flex overflow-hidden">
        {/* Left: Report (complete) or live progress (running) */}
        <div className="flex-1 flex flex-col min-w-0">
          {report ? (
            <InvestigationReportView
              report={report}
              title={investigation.intent}
            />
          ) : (
            <div className="flex-1 overflow-y-auto overscroll-contain bg-surface-lowest">
              <LiveProgressView investigation={investigation} />
            </div>
          )}

          <div className="shrink-0 px-6 py-2 flex items-center gap-2">
            <span
              className={`w-1.5 h-1.5 rounded-full ${isGenerating ? 'bg-primary animate-pulse' : investigation.status === 'completed' ? 'bg-secondary' : 'bg-red-400'}`}
            />
            <span className="text-xs text-on-surface-variant">
              {isGenerating
                ? statusDescription(investigation.status)
                : investigation.status === 'completed'
                  ? `${investigation.evidence?.length ?? 0} evidence · ${investigation.hypotheses?.length ?? 0} hypotheses`
                  : 'Failed'}
            </span>
          </div>
        </div>

        {/* Chat is now in the global Layout — no embedded ChatPanel here */}
      </div>
    </div>
  );
}
