import React, { useCallback, useEffect, useState } from 'react';
import { apiClient } from '../api/client.js';
import { relativeTime } from '../utils/time.js';

// Types

type ApprovalStatus = 'pending' | 'approved' | 'rejected' | 'expired';
type RiskLevel = 'low' | 'medium' | 'high' | 'critical';

interface ApprovalAction {
  type: string;
  targetService: string;
  params: Record<string, unknown>;
}

interface ApprovalContext {
  investigationId: string;
  requestedBy: string;
  reason: string;
}

interface ApprovalRequest {
  id: string;
  action: ApprovalAction;
  context: ApprovalContext;
  status: ApprovalStatus;
  createdAt: string;
  expiresAt?: string;
  resolvedAt?: string;
  resolvedBy?: string;
}

// Helpers

function expiresIn(iso: string): string {
  const diff = new Date(iso).getTime() - Date.now();
  if (diff <= 0) return 'expired';
  const mins = Math.floor(diff / 60000);
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  return `${hrs}h`;
}

/** Derive a display risk level from the action type */
function actionRisk(type: string): RiskLevel {
  const t = type.toLowerCase();
  if (t.includes('rollback') || t.includes('scale') || t.includes('delete')) return 'high';
  if (t.includes('restart') || t.includes('deploy') || t.includes('flag')) return 'medium';
  return 'low';
}

const RISK_STYLES: Record<RiskLevel, string> = {
  low: 'bg-[var(--color-surface-high)] text-[#B8B8A0]',
  medium: 'bg-[#F59E0B]/10 text-[#F59E0B]',
  high: 'bg-[#F97316]/10 text-[#F97316]',
  critical: 'bg-[#EF4444]/10 text-[#EF4444]',
};

const STATUS_STYLES: Record<ApprovalStatus, string> = {
  pending: 'bg-[#F59E0B]/10 text-[#F59E0B]',
  approved: 'bg-[#22C55E]/10 text-[#22C55E]',
  rejected: 'bg-[#EF4444]/10 text-[#EF4444]',
  expired: 'bg-[var(--color-surface-high)] text-[var(--color-outline)]',
};

// Action Card

interface ActionCardProps {
  request: ApprovalRequest;
  processing: boolean;
  onApprove: (id: string) => void;
  onReject: (id: string) => void;
}

function ActionCard({ request, processing, onApprove, onReject }: ActionCardProps) {
  const risk = actionRisk(request.action.type);
  const isPending = request.status === 'pending';

  return (
    <div className="bg-[var(--color-surface-highest)] rounded-xl border border-[var(--color-outline-variant)] p-4 space-y-3">
      {/* Header row */}
      <div className="flex items-start justify-between">
        <div className="flex items-center gap-3 flex-wrap">
          <span className="font-mono text-sm font-semibold text-[#EAE8DE]">
            {request.action.type}
          </span>
          <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-semibold uppercase tracking-wide ${RISK_STYLES[risk]}`}>
            {risk}
          </span>
          <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-semibold uppercase tracking-wide ${STATUS_STYLES[request.status]}`}>
            {request.status}
          </span>
        </div>
        <span className="text-xs text-[var(--color-outline)] shrink-0">{relativeTime(request.createdAt)}</span>
      </div>

      {/* Target service */}
      <div className="text-sm text-[#B8B8A0]">
        <span className="text-[var(--color-outline)]">Target:</span>{' '}
        <span className="font-medium">{request.action.targetService}</span>
      </div>

      {/* Reason */}
      <p className="text-sm text-[#B8B8A0]">{request.context.reason}</p>

      {/* Params (collapsed preview) */}
      {Object.keys(request.action.params).length > 0 && (
        <pre className="text-xs bg-[#0B0B14] rounded-lg p-3 overflow-auto text-[#B8B8A0] border border-[var(--color-outline-variant)]">
          {JSON.stringify(request.action.params, null, 2)}
        </pre>
      )}

      {/* Footer row - stacks vertically on mobile */}
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 pt-1">
        <div className="text-xs text-[var(--color-outline)] space-x-3">
          <span>Context: {request.context.investigationId.slice(0, 8)}…</span>
          {request.expiresAt && <span>expires in {expiresIn(request.expiresAt)}</span>}
          {request.resolvedBy && <span>resolved by {request.resolvedBy}</span>}
        </div>

        {isPending && (
          <div className="flex gap-2">
            <button
              type="button"
              disabled={processing}
              onClick={() => onReject(request.id)}
              className="flex-1 self-stretch px-4 py-2.5 sm:py-1.5 rounded-lg text-sm sm:text-xs font-medium border border-[var(--color-outline-variant)] text-[#B8B8A0] hover:bg-[var(--color-surface-high)] hover:text-[#E8E8E0] disabled:opacity-50 transition-colors"
            >
              Reject
            </button>
            <button
              type="button"
              disabled={processing}
              onClick={() => onApprove(request.id)}
              className="flex-1 sm:flex-none px-4 py-2.5 sm:py-1.5 rounded-lg text-sm sm:text-xs font-medium bg-[var(--color-primary)] text-white hover:bg-[var(--color-primary)] disabled:opacity-50 transition-colors"
            >
              {processing ? 'Processing…' : 'Approve'}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

// Main component

export default function ActionCenter() {
  const [pending, setPending] = useState<ApprovalRequest[]>([]);
  const [resolved, setResolved] = useState<ApprovalRequest[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [processing, setProcessing] = useState<Set<string>>(new Set());
  const [actionError, setActionError] = useState<string | null>(null);
  const [tab, setTab] = useState<'pending' | 'resolved'>('pending');

  const loadApprovals = useCallback(async () => {
    const res = await apiClient.get<ApprovalRequest[]>('/approvals');
    if (res.error) {
      setError(res.error.message);
    } else {
      setPending(res.data.filter((r) => r.status === 'pending'));
      setResolved(res.data.filter((r) => r.status !== 'pending'));
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    void loadApprovals();
    // Poll every 10s to reflect state changes from the agent
    const timer = setInterval(() => { void loadApprovals(); }, 10_000);
    return () => clearInterval(timer);
  }, [loadApprovals]);

  const handleApprove = useCallback(async (id: string) => {
    setActionError(null);
    setProcessing((prev) => new Set(prev).add(id));
    const res = await apiClient.post<ApprovalRequest>(`/approvals/${id}/approve`, {});
    setProcessing((prev) => { const s = new Set(prev); s.delete(id); return s; });
    if (res.error) {
      setActionError(`Approve failed: ${res.error.message}`);
    } else {
      await loadApprovals();
    }
  }, [loadApprovals]);

  const handleReject = useCallback(async (id: string) => {
    setActionError(null);
    setProcessing((prev) => new Set(prev).add(id));
    const res = await apiClient.post<ApprovalRequest>(`/approvals/${id}/reject`, {});
    setProcessing((prev) => { const s = new Set(prev); s.delete(id); return s; });
    if (res.error) {
      setActionError(`Reject failed: ${res.error.message}`);
    } else {
      await loadApprovals();
    }
  }, [loadApprovals]);

  const displayed = tab === 'pending' ? pending : resolved;

  return (
    <div className="max-w-3xl mx-auto px-4 sm:px-6 py-6 sm:py-8 space-y-4 bg-[var(--color-surface-lowest)] min-h-full">
      {/* Page header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-[#EAE8DE]">Action Center</h1>
          <p className="text-sm text-[#B8B8A0]">
            Recommended operations awaiting human approval
          </p>
        </div>
        <button
          type="button"
          onClick={() => void loadApprovals()}
          className="text-xs text-[#B8B8A0] hover:text-[var(--color-primary)] px-3 py-1.5 rounded-lg border border-[var(--color-outline-variant)] hover:bg-[var(--color-surface-high)] transition-colors"
        >
          Refresh
        </button>
      </div>

      {/* Summary badges */}
      <div className="flex gap-3">
        <div className="bg-[#F59E0B]/10 border border-[#F59E0B]/20 rounded-lg px-4 py-2 text-center">
          <div className="text-2xl font-bold text-[#F59E0B]">{pending.length}</div>
          <div className="text-xs text-[#F59E0B]/70">Pending</div>
        </div>
        <div className="bg-[#22C55E]/10 border border-[#22C55E]/20 rounded-lg px-4 py-2 text-center">
          <div className="text-2xl font-bold text-[#22C55E]">
            {resolved.filter(r => r.status === 'approved').length}
          </div>
          <div className="text-xs text-[#22C55E]/70">Approved</div>
        </div>
        <div className="bg-[#EF4444]/10 border border-[#EF4444]/20 rounded-lg px-4 py-2 text-center">
          <div className="text-2xl font-bold text-[#EF4444]">
            {resolved.filter(r => r.status === 'rejected').length}
          </div>
          <div className="text-xs text-[#EF4444]/70">Rejected</div>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex border-b border-[var(--color-outline-variant)]">
        {(['pending', 'resolved'] as const).map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => setTab(t)}
            className={`px-4 py-2 text-sm font-medium capitalize border-b-2 transition-colors ${
              tab === t
                ? 'border-[var(--color-primary)] text-[var(--color-primary)]'
                : 'border-transparent text-[var(--color-outline)] hover:text-[#4E8EDE]'
            }`}
          >
            {t}
            {t === 'pending' && pending.length > 0 && (
              <span className="ml-1.5 bg-[#F59E0B]/20 text-[#F59E0B] text-xs font-semibold px-1.5 py-0.5 rounded-full">
                {pending.length}
              </span>
            )}
          </button>
        ))}
      </div>

      {/* Action error toast */}
      {actionError && (
        <div className="flex items-center justify-between px-4 py-3 rounded-xl bg-[#EF4444]/10 border border-[#EF4444]/20 text-sm text-[#EF4444]">
          <span>{actionError}</span>
          <button
            type="button"
            onClick={() => setActionError(null)}
            className="ml-3 text-[#EF4444]/70 hover:text-[#EF4444] font-semibold"
          >
            x
          </button>
        </div>
      )}

      {/* Content */}
      {loading ? (
        <div className="flex items-center justify-center py-16">
          <span className="inline-block w-5 h-5 border-2 border-[var(--color-outline-variant)] border-t-[var(--color-primary)] rounded-full animate-spin" />
        </div>
      ) : error ? (
        <div className="px-4 py-3 rounded-xl bg-[#EF4444]/10 border border-[#EF4444]/20 text-sm text-[#EF4444]">
          {error}
        </div>
      ) : displayed.length === 0 ? (
        <div className="text-center py-16 text-[var(--color-outline)] text-sm">
          {tab === 'pending' ? 'No pending approvals' : 'No resolved actions yet'}
        </div>
      ) : (
        <div className="space-y-3">
          {displayed.map((req) => (
            <ActionCard
              key={req.id}
              request={req}
              processing={processing.has(req.id)}
              onApprove={(id) => { void handleApprove(id); }}
              onReject={(id) => { void handleReject(id); }}
            />
          ))}
        </div>
      )}
    </div>
  );
}
