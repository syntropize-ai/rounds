import React, { useCallback, useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { apiClient } from '../api/client.js';

// Types

interface PostMortemTimelineEntry {
  timestamp: string;
  description: string;
}

interface PostMortemReport {
  id: string;
  incidentId: string;
  summary: string;
  impact: string;
  timeline: PostMortemTimelineEntry[];
  rootCause: string;
  actionsTaken: string[];
  lessonsLearned: string[];
  actionItems: string[];
  generatedAt: string;
  generatedBy: 'llm' | 'fallback';
}

// Markdown export

function buildMarkdown(report: PostMortemReport): string {
  const lines: string[] = [];
  lines.push(`# Post-Mortem Report - Incident ${report.incidentId}`);
  lines.push(`Generated: ${new Date(report.generatedAt).toLocaleString()}`);
  if (report.generatedBy === 'fallback') {
    lines.push('*Warning: LLM was unavailable. This report was generated from a template.*');
  }
  lines.push('');
  lines.push('## Summary');
  lines.push(report.summary);
  lines.push('');
  lines.push('## Impact');
  lines.push(report.impact);
  lines.push('');
  if (report.timeline.length > 0) {
    lines.push('## Timeline');
    for (const entry of report.timeline) {
      lines.push(`- **${new Date(entry.timestamp).toLocaleString()}** - ${entry.description}`);
    }
    lines.push('');
  }
  lines.push('## Root Cause');
  lines.push(report.rootCause);
  lines.push('');
  if (report.actionsTaken.length > 0) {
    lines.push('## Actions Taken');
    for (const action of report.actionsTaken) {
      lines.push(`- ${action}`);
    }
    lines.push('');
  }
  if (report.lessonsLearned.length > 0) {
    lines.push('## Lessons Learned');
    for (const lesson of report.lessonsLearned) {
      lines.push(`- ${lesson}`);
    }
    lines.push('');
  }
  if (report.actionItems.length > 0) {
    lines.push('## Action Items');
    for (const item of report.actionItems) {
      lines.push(`- [ ] ${item}`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

function downloadMarkdown(report: PostMortemReport): void {
  const content = buildMarkdown(report);
  const blob = new Blob([content], { type: 'text/markdown;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `post-mortem-${report.incidentId}.md`;
  a.click();
  URL.revokeObjectURL(url);
}

// Sub-components

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="bg-white rounded-xl border border-slate-200 p-5 space-y-3">
      <h2 className="text-base font-semibold text-slate-800">{title}</h2>
      {children}
    </section>
  );
}

function StringList({ items }: { items: string[] }) {
  if (items.length === 0) return <p className="text-sm text-slate-400 italic">None recorded.</p>;
  return (
    <ul className="space-y-1.5">
      {items.map((item, i) => (
        <li key={i} className="flex gap-2 text-sm text-slate-700">
          <span className="text-slate-400 shrink-0 pt-0.5">•</span>
          <span>{item}</span>
        </li>
      ))}
    </ul>
  );
}

// Main component

export default function PostMortem() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();

  const [report, setReport] = useState<PostMortemReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadReport = useCallback(async () => {
    if (!id) return;
    const res = await apiClient.get<PostMortemReport>(`/incidents/${id}/post-mortem`);
    if (res.error) {
      if ((res.error as { code?: string }).code === 'NOT_FOUND') {
        setReport(null);
      } else {
        setError(res.error.message);
      }
    } else {
      setReport(res.data);
      setError(null);
    }
    setLoading(false);
  }, [id]);

  useEffect(() => {
    void loadReport();
  }, [loadReport]);

  const handleGenerate = useCallback(async (force = false) => {
    if (!id) return;
    setGenerating(true);
    setError(null);
    const res = await apiClient.post<PostMortemReport>(`/incidents/${id}/post-mortem`, { force });
    setGenerating(false);
    if (res.error) {
      setError(res.error.message);
    } else {
      setReport(res.data);
    }
  }, [id]);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-24">
        <span className="inline-block w-5 h-5 border-2 border-indigo-200 border-t-indigo-600 rounded-full animate-spin" />
      </div>
    );
  }

  return (
    <div className="max-w-3xl mx-auto px-4 py-8 space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <button
            type="button"
            onClick={() => navigate(-1)}
            className="text-sm text-slate-400 hover:text-slate-600 mb-2 flex items-center gap-1"
          >
            ← Back
          </button>
          <h1 className="text-2xl font-bold text-slate-900">Post-Mortem Report</h1>
          {report && (
            <p className="text-sm text-slate-400 mt-1">
              Generated {new Date(report.generatedAt).toLocaleString()}
              {report.generatedBy === 'fallback' && (
                <span className="ml-2 inline-flex items-center gap-1.5 rounded-full bg-amber-100 text-amber-700 px-2 py-0.5 text-xs font-medium">
                  Template fallback
                </span>
              )}
            </p>
          )}
        </div>

        <div className="flex gap-2 shrink-0">
          {report && (
            <>
              <button
                type="button"
                onClick={() => downloadMarkdown(report)}
                className="px-3 py-1.5 rounded-lg text-xs font-medium border border-slate-200 text-slate-600 hover:bg-slate-50 transition-colors"
              >
                Export Markdown
              </button>
              <button
                type="button"
                disabled={generating}
                onClick={() => void handleGenerate(true)}
                className="px-3 py-1.5 rounded-lg text-xs font-medium border border-indigo-200 text-indigo-600 hover:bg-indigo-50 disabled:opacity-50 transition-colors"
              >
                {generating ? 'Regenerating...' : 'Regenerate'}
              </button>
            </>
          )}
        </div>
      </div>

      {error && (
        <div className="px-4 py-3 rounded-xl bg-red-50 border border-red-100 text-sm text-red-700">
          {error}
        </div>
      )}

      {report?.generatedBy === 'fallback' && (
        <div className="px-4 py-3 rounded-xl bg-amber-50 border border-amber-100 text-sm text-amber-700">
          The LLM was unavailable when this report was generated. Content may be incomplete. We generated a summary from the raw timeline.
        </div>
      )}

      {!report && !error && (
        <div className="flex flex-col items-center justify-center py-20 gap-4">
          <p className="text-slate-500 text-sm">No post-mortem report has been generated yet.</p>
          <button
            type="button"
            disabled={generating}
            onClick={() => void handleGenerate(false)}
            className="px-4 py-2 rounded-lg text-sm font-medium bg-indigo-600 text-white hover:bg-indigo-700 disabled:opacity-50 transition-colors"
          >
            {generating ? 'Generating...' : 'Generate Post-Mortem'}
          </button>
        </div>
      )}

      {report && (
        <div className="space-y-4">
          <Section title="Summary">
            <p className="text-sm text-slate-700 leading-relaxed">{report.summary}</p>
          </Section>

          <Section title="Impact">
            <p className="text-sm text-slate-700 leading-relaxed">{report.impact}</p>
          </Section>

          {report.timeline.length > 0 && (
            <Section title="Timeline">
              <ol className="space-y-3">
                {report.timeline.map((entry, i) => (
                  <li key={i} className="flex gap-3">
                    <div className="flex flex-col items-center">
                      <div className="w-2 h-2 rounded-full bg-indigo-400 mt-1.5 shrink-0" />
                      {i < report.timeline.length - 1 && (
                        <div className="w-px flex-1 bg-slate-200 mt-1" />
                      )}
                    </div>
                    <div className="pb-3">
                      <p className="text-xs text-slate-400 font-mono">
                        {new Date(entry.timestamp).toLocaleString()}
                      </p>
                      <p className="text-sm text-slate-700 mt-0.5">{entry.description}</p>
                    </div>
                  </li>
                ))}
              </ol>
            </Section>
          )}

          <Section title="Root Cause">
            <p className="text-sm text-slate-700 leading-relaxed">{report.rootCause}</p>
          </Section>

          <Section title="Actions Taken">
            <StringList items={report.actionsTaken} />
          </Section>

          <Section title="Lessons Learned">
            <StringList items={report.lessonsLearned} />
          </Section>

          <Section title="Action Items">
            {report.actionItems.length === 0 ? (
              <p className="text-sm text-slate-400 italic">No action items.</p>
            ) : (
              <ul className="space-y-1.5">
                {report.actionItems.map((item, i) => (
                  <li key={i} className="flex gap-2 text-sm text-slate-700">
                    <span className="text-slate-400 shrink-0 pt-0.5 font-mono">[ ]</span>
                    <span>{item}</span>
                  </li>
                ))}
              </ul>
            )}
          </Section>
        </div>
      )}
    </div>
  );
}
