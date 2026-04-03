import React, { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { apiClient } from '../api/client.js';

// Types

interface ApprovalRequest {
  id: string;
  action: { type: string; targetService: string };
  context: { reason: string };
  status: 'pending' | 'approved' | 'rejected' | 'expired';
  createdAt: string;
}

interface FeedItemSummary {
  id: string;
  type: string;
  title: string;
  summary: string;
  severity: string;
  createdAt: string;
}

interface FeedPage {
  items: FeedItemSummary[];
  total: number;
}

// Stat card

function StatCard({
  label,
  value,
  color,
  to,
}: {
  label: string;
  value: number | string;
  color: string;
  to: string;
}) {
  return (
    <Link to={to} className="block rounded-xl border p-4 hover:shadow-sm transition-shadow" style={{ borderColor: 'rgb(226 232 240)' }}>
      <div className="text-2xl font-bold" style={{ color }}>
        {value}
      </div>
      <div className="text-xs font-medium mt-0.5 opacity-80">{label}</div>
    </Link>
  );
}

// Quick-action button

function QuickLink({
  to,
  icon,
  label,
  description,
}: {
  to: string;
  icon: string;
  label: string;
  description: string;
}) {
  return (
    <Link
      to={to}
      className="flex items-center gap-3 bg-white rounded-xl border border-slate-200 px-4 py-3 hover:bg-slate-50 hover:border-indigo-200 transition-colors"
    >
      <span className="text-2xl">{icon}</span>
      <div>
        <div className="text-sm font-semibold text-slate-800">{label}</div>
        <div className="text-xs text-slate-400">{description}</div>
      </div>
    </Link>
  );
}

// Recent execution row

function RecentExecRow({ item }: { item: FeedItemSummary }) {
  const ago = (() => {
    const diff = Date.now() - new Date(item.createdAt).getTime();
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins}m ago`;
    const hrs = Math.floor(mins / 60);
    return hrs < 24 ? `${hrs}h ago` : `${Math.floor(hrs / 24)}d ago`;
  })();

  return (
    <div className="flex items-start gap-2 py-2 border-b border-slate-100 last:border-b-0">
      <span className="mt-0.5 w-1.5 h-1.5 rounded-full bg-emerald-500 shrink-0" />
      <div className="flex-1 min-w-0">
        <p className="text-sm text-slate-700 truncate">{item.title}</p>
        <p className="text-xs text-slate-400 truncate">{item.summary}</p>
      </div>
      <span className="text-xs text-slate-400 shrink-0">{ago}</span>
    </div>
  );
}

// Main component

export default function DashboardPanel() {
  const [pendingCount, setPendingCount] = useState<number | null>(null);
  const [recentExecs, setRecentExecs] = useState<FeedItemSummary[]>([]);

  const load = useCallback(async () => {
    const [approvalsRes, execsRes] = await Promise.all([
      apiClient.get<ApprovalRequest[]>('/approvals'),
      apiClient.get<FeedPage>('/feed?type=action_executed&limit=5'),
    ]);

    if (!approvalsRes.error) {
      setPendingCount(approvalsRes.data.filter((r) => r.status === 'pending').length);
    }
    if (!execsRes.error) {
      setRecentExecs(execsRes.data.items);
    }
  }, []);

  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), 30_000);
    return () => clearInterval(timer);
  }, [load]);

  return (
    <div className="space-y-5 mb-8">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        <StatCard
          label="Pending Approvals"
          value={pendingCount ?? '—'}
          color={pendingCount !== null && pendingCount > 0 ? '#d97706' : '#64748b'}
          to="/actions"
        />
        <StatCard
          label="Recent Executions"
          value={recentExecs.length > 0 ? recentExecs.length : '—'}
          color="#059669"
          to="/actions"
        />
        <StatCard
          label="Investigations"
          value="View all"
          color="#4f46e5"
          to="/investigate"
        />
      </div>

      <div>
        <div className="text-xs font-semibold text-slate-400 uppercase tracking-wide mb-2">
          Quick Navigation
        </div>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
          <QuickLink
            to="/actions"
            icon=">"
            label="Action Center"
            description="Review & approve LLM-recommended ops"
          />
          <QuickLink
            to="/investigate"
            icon="?"
            label="Investigate"
            description="Start or continue an investigation"
          />
          <QuickLink
            to="/actions"
            icon="!"
            label="Approval Queue"
            description={
              pendingCount !== null && pendingCount > 0
                ? `${pendingCount} pending approval${pendingCount > 1 ? 's' : ''}`
                : 'No pending approvals'
            }
          />
        </div>
      </div>

      {recentExecs.length > 0 && (
        <div className="bg-white rounded-xl border border-slate-200 p-4">
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-sm font-semibold text-slate-700">Recent Executions</h2>
            <Link to="/actions" className="text-xs text-indigo-600 hover:text-indigo-800">
              View all
            </Link>
          </div>
          <div>
            {recentExecs.map((item) => (
              <RecentExecRow key={item.id} item={item} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
