import React, { useCallback, useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { apiClient } from '../api/client.js';
import InvestigationReportView from '../components/InvestigationReportView.js';
import ConfirmDialog from '../components/ConfirmDialog.js';
import type { InvestigationReport, InvestigationReportSection } from '../hooks/useDashboardChat.js';

// Types

interface SavedInvestigationReport {
  id: string;
  dashboardId: string;
  goal: string;
  summary: string;
  sections: InvestigationReportSection[];
  createdAt: string;
}

// Helpers

function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

// Sidebar report card

function ReportCard({
  report,
  active,
  onClick,
  onDelete,
}: {
  report: SavedInvestigationReport;
  active: boolean;
  onClick: () => void;
  onDelete: (e: React.MouseEvent) => void;
}) {
  return (
    <div className="relative group">
      <button
        type="button"
        onClick={onClick}
        className={`w-full text-left px-3 py-3 rounded-lg transition-colors border ${
          active
            ? 'bg-[#1C1C2E] border-[#6366F1]'
            : 'bg-transparent border-transparent hover:border-[#2A2A3E] hover:bg-[#1C1C2E]'
        }`}
      >
        <p className="text-sm font-medium text-[#E8E8ED] truncate leading-snug">{report.goal}</p>
        <p className="text-xs text-[#8888AA] mt-1 line-clamp-2 leading-relaxed">{report.summary}</p>
        <p className="text-xs text-[#555570] mt-1.5">{relativeTime(report.createdAt)}</p>
      </button>

      <button
        type="button"
        onClick={onDelete}
        aria-label="Delete report"
        className="absolute top-2 right-2 w-5 h-5 flex items-center justify-center rounded text-[#555570] hover:text-[#EF4444] bg-[#2A2A3E] opacity-0 group-hover:opacity-100 transition-opacity"
      >
        <svg className="w-3 h-3" viewBox="0 0 20 20" fill="currentColor">
          <path
            fillRule="evenodd"
            d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z"
            clipRule="evenodd"
          />
        </svg>
      </button>
    </div>
  );
}

// Main component

export default function Workspace() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();

  const [reports, setReports] = useState<SavedInvestigationReport[]>([]);
  const [listLoading, setListLoading] = useState(true);
  const [activeReport, setActiveReport] = useState<SavedInvestigationReport | null>(null);
  const [reportLoading, setReportLoading] = useState(false);
  const [newPrompt, setNewPrompt] = useState('');
  const [creating, setCreating] = useState(false);
  const [deletingReportId, setDeletingReportId] = useState<string | null>(null);

  const handleNewInvestigation = useCallback(async () => {
    const trimmed = newPrompt.trim();
    if (!trimmed || creating) return;
    setCreating(true);
    try {
      const res = await apiClient.post<{ id: string }>('/dashboards', {
        prompt: `Investigate: ${trimmed}`,
        stream: true,
      });
      if (!res.error) {
        navigate(`/dashboards/${res.data.id}`);
      }
    } finally {
      setCreating(false);
    }
  }, [newPrompt, creating, navigate]);

  // Load report list on mount
  useEffect(() => {
    setListLoading(true);
    void apiClient
      .get<SavedInvestigationReport[]>('/dashboards/investigations')
      .then((res) => {
        if (!res.error) {
          setReports(res.data);
        }
      })
      .finally(() => setListLoading(false));
  }, []);

  // Load individual report when id param changes
  useEffect(() => {
    if (!id) {
      setActiveReport(null);
      return;
    }

    // Check if it's already in the list to avoid redundant fetch
    const cached = reports.find((r) => r.id === id);
    if (cached) {
      setActiveReport(cached);
      return;
    }

    setReportLoading(true);
    void apiClient
      .get<SavedInvestigationReport>(`/dashboards/investigations/${id}`)
      .then((res) => {
        if (!res.error) {
          setActiveReport(res.data);
        }
      })
      .finally(() => setReportLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  // Delete handler

  const handleDelete = (reportId: string) => (e: React.MouseEvent) => {
    e.stopPropagation();
    void apiClient.delete(`/dashboards/investigations/${reportId}`).then((res) => {
      if (!res.error) {
        setReports((prev) => prev.filter((r) => r.id !== reportId));
        if (id === reportId) {
          navigate('/investigate');
        }
      }
    });
  };

  // Build InvestigationReport from SavedInvestigationReport
  const reportForView: InvestigationReport | null = activeReport
    ? { summary: activeReport.summary, sections: activeReport.sections }
    : null;

  // Render

  return (
    <div className="flex h-full bg-[#0A0A0F]">
      <aside
        className={`bg-[#141420] border-r border-[#2A2A3E] flex flex-col shrink-0 ${
          id ? 'hidden md:flex' : 'flex'
        } md:w-72`}
      >
        <div className="px-4 py-3 border-b border-[#2A2A3E]">
          <h2 className="text-sm font-semibold text-[#E8E8ED]">Investigation Reports</h2>
          <p className="text-xs text-[#555570] mt-0.5">Saved investigation reports</p>
        </div>

        <div className="flex-1 overflow-y-auto p-2 space-y-1">
          {listLoading ? (
            <div className="flex items-center justify-center py-10">
              <span className="inline-block w-4 h-4 border-2 border-[#2A2A3E] border-t-[#6366F1] rounded-full animate-spin" />
            </div>
          ) : reports.length === 0 ? (
            <p className="text-sm text-[#8888AA] text-center py-8 px-3 leading-relaxed">
              No saved investigations yet. Start from the dashboard chat.
            </p>
          ) : (
            reports.map((report) => (
              <ReportCard
                key={report.id}
                report={report}
                active={report.id === id}
                onClick={() => navigate(`/investigate/${report.id}`)}
                onDelete={(e) => {
                  e.stopPropagation();
                  setDeletingReportId(report.id);
                }}
              />
            ))
          )}
        </div>
      </aside>

      <div className={`flex-1 overflow-hidden flex flex-col ${id ? 'flex' : 'hidden md:flex'}`}>
        {id && (
          <div className="md:hidden shrink-0 px-4 py-2 border-b border-[#2A2A3E]">
            <button
              type="button"
              onClick={() => navigate('/investigate')}
              className="inline-flex items-center gap-2 text-sm text-[#6366F1] hover:text-[#818CF8] font-medium"
            >
              <svg className="w-4 h-4" viewBox="0 0 20 20" fill="currentColor">
                <path
                  fillRule="evenodd"
                  d="M12.707 14.707a1 1 0 01-1.414 0L6.586 10l4.707-4.707a1 1 0 111.414 1.414L9.414 10l3.293 3.293a1 1 0 010 1.414z"
                  clipRule="evenodd"
                />
              </svg>
              All Investigations
            </button>
          </div>
        )}

        {reportLoading && (
          <div className="flex-1 flex items-center justify-center">
            <span className="inline-block w-6 h-6 border-2 border-[#2A2A3E] border-t-[#6366F1] rounded-full animate-spin" />
          </div>
        )}

        {!reportLoading && reportForView && (
          <div className="flex-1 overflow-hidden">
            <InvestigationReportView
              report={reportForView}
              onClose={() => navigate('/investigate')}
            />
          </div>
        )}

        {!reportLoading && !reportForView && (
          <div className="flex-1 flex flex-col">
            <div className="flex-1 flex flex-col items-center justify-center gap-4 px-4 text-center">
              <div className="w-14 h-14 rounded-2xl bg-gradient-to-br from-[#6366F1]/20 to-[#58C5C6]/20 border border-[#6366F1]/20 flex items-center justify-center">
                <svg className="w-7 h-7 text-[#6366F1]" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-5.197-5.197M4.7 10a5.3 5.3 0 1010.6 0 5.3 5.3 0 00-10.6 0z" />
                </svg>
              </div>
              <div>
                <h1 className="text-xl font-semibold text-[#E8E8ED] mb-1">Start an Investigation</h1>
                <p className="text-sm text-[#555570]">
                  Describe a service to investigate, a high latency, error spikes, resource issues, or any infrastructure concern.
                </p>
              </div>

              <div className="w-full max-w-md mt-2">
                <input
                  type="text"
                  value={newPrompt}
                  onChange={(e) => setNewPrompt(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
                      void handleNewInvestigation();
                    }
                  }}
                  placeholder="e.g. Why is API latency increasing?"
                  disabled={creating}
                  className="w-full bg-[#141420] border border-[#2A2A3E] rounded-xl px-4 py-3.5 text-sm text-[#E8E8ED] placeholder-[#555570] focus:outline-none focus:border-[#6366F1]"
                />
                <button
                  type="button"
                  onClick={() => void handleNewInvestigation()}
                  disabled={!newPrompt.trim() || creating}
                  className="mt-3 inline-flex items-center justify-center gap-2 px-5 py-2.5 bg-[#6366F1] text-white text-sm font-medium rounded-xl hover:bg-[#818CF8] disabled:opacity-50 transition-colors"
                >
                  {creating && (
                    <span className="inline-block w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                  )}
                  Investigate
                </button>
              </div>

              {reports.length === 0 && (
                <p className="text-xs text-[#555570] mt-3">
                  No past investigations yet. Your investigation history will appear in the sidebar.
                </p>
              )}
            </div>
          </div>
        )}
      </div>

      <ConfirmDialog
        open={deletingReportId !== null}
        title="Delete investigation?"
        message="This investigation report will be permanently deleted."
        onConfirm={() => {
          if (deletingReportId) {
            void apiClient
              .delete(`/dashboards/investigations/${deletingReportId}`)
              .then((res) => {
                if (!res.error) {
                  setReports((prev) => prev.filter((r) => r.id !== deletingReportId));
                  if (id === deletingReportId) navigate('/investigate');
                }
              });
          }
          setDeletingReportId(null);
        }}
        onCancel={() => setDeletingReportId(null)}
      />
    </div>
  );
}
