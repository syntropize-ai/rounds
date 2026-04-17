import React, { useCallback, useEffect, useState, useMemo, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { apiClient } from '../api/client.js';
import ConfirmDialog from '../components/ConfirmDialog.js';
import { relativeTime } from '../utils/time.js';

// Types

type AlertRuleState = 'normal' | 'pending' | 'firing' | 'resolved' | 'disabled';
type AlertSeverity = 'critical' | 'high' | 'medium' | 'low';

interface AlertCondition {
  query: string;
  operator: string;
  threshold: number;
  forDurationSec: number;
}

interface AlertRule {
  id: string;
  name: string;
  description: string;
  originalPrompt?: string;
  condition: AlertCondition;
  evaluationIntervalSec: number;
  severity: AlertSeverity;
  labels: Record<string, string>;
  state: AlertRuleState;
  stateChangedAt: string;
  createdAt: string;
  updatedAt: string;
  lastEvaluatedAt?: string;
  lastFiredAt?: string;
  fireCount: number;
  investigationId?: string;
}

// Helpers

/** Convert PascalCase/camelCase rule names to readable text: "PrometheusQueryLatencyHigh" → "Prometheus Query Latency High" */
function humanizeName(name: string): string {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .replace(/_/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function nextEval(rule: AlertRule): string {
  if (!rule.lastEvaluatedAt) return 'pending';
  const lastMs = new Date(rule.lastEvaluatedAt).getTime();
  const nextMs = lastMs + rule.evaluationIntervalSec * 1000;
  const diffSec = Math.max(0, Math.round((nextMs - Date.now()) / 1000));
  if (diffSec < 60) return `in ${diffSec}s`;
  return `in ${Math.ceil(diffSec / 60)}m`;
}


const STATE_STYLES: Record<AlertRuleState, { dot: string; text: string; bg: string; label: string }> = {
  firing: { dot: 'bg-[#EF4444] animate-pulse', text: 'text-[#EF4444]', bg: 'bg-[#EF4444]/10', label: 'Firing' },
  pending: { dot: 'bg-[#F59E0B] animate-pulse', text: 'text-[#F59E0B]', bg: 'bg-[#F59E0B]/10', label: 'Pending' },
  normal: { dot: 'bg-[#22C55E]', text: 'text-[#22C55E]', bg: 'bg-[#22C55E]/10', label: 'Normal' },
  resolved: { dot: 'bg-[#22C55E]', text: 'text-[var(--color-on-surface-variant)]', bg: 'bg-[#22C55E]/10', label: 'Resolved' },
  disabled: { dot: 'bg-[var(--color-outline)]', text: 'text-[var(--color-outline)]', bg: 'bg-[var(--color-outline)]/10', label: 'Disabled' },
};

const SEVERITY_STYLES: Record<AlertSeverity, string> = {
  critical: 'bg-[#EF4444]/10 text-[#EF4444] border-[#EF4444]/20',
  high: 'bg-[#F97316]/10 text-[#F97316] border-[#F97316]/20',
  medium: 'bg-[#F59E0B]/10 text-[#F59E0B] border-[#F59E0B]/20',
  low: 'bg-[var(--color-surface-high)] text-[var(--color-on-surface-variant)] border-[var(--color-outline-variant)]',
};


// Expandable Rule Row

function AlertRuleRow({
  rule,
  expanded,
  onToggleExpand,
  onToggleState,
  onDelete,
  onInvestigate,
  investigating,
  navigate,
}: {
  rule: AlertRule;
  expanded: boolean;
  onToggleExpand: () => void;
  onToggleState: () => void;
  onDelete: () => void;
  onInvestigate: () => void;
  investigating: boolean;
  navigate: (path: string, opts?: { state?: unknown }) => void;
}) {
  const stateStyle = STATE_STYLES[rule.state];
  const isDisabled = rule.state === 'disabled';
  const dashboardId = rule.labels?.dashboardId;

  return (
    <div className={`rounded-xl border transition-all ${
      rule.state === 'firing'
        ? 'bg-[var(--color-surface-highest)] border-[#EF4444]/30'
        : rule.state === 'pending'
        ? 'bg-[var(--color-surface-highest)] border-[#F59E0B]/30'
        : 'bg-[var(--color-surface-highest)] border-[var(--color-outline-variant)] hover:border-[#36364E]'
    } ${isDisabled ? 'opacity-60' : ''}`}>
      {/* Summary row (always visible) */}
      <button
        onClick={onToggleExpand}
        className="w-full text-left px-4 py-3 flex items-center gap-3"
      >
        {/* Expand chevron */}
        <svg className={`w-3.5 h-3.5 text-[var(--color-outline)] transition-transform shrink-0 ${expanded ? 'rotate-90' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
        </svg>

        {/* State badge */}
        <span className={`px-2 py-0.5 rounded text-[10px] font-bold uppercase ${stateStyle.bg} ${stateStyle.text} shrink-0`}>
          {stateStyle.label}
        </span>

        {/* Name */}
        <span className="text-sm font-medium text-[var(--color-on-surface)] truncate flex-1">
          {humanizeName(rule.name)}
        </span>

        {/* Severity */}
        <span className={`px-1.5 py-0.5 rounded text-[10px] font-semibold uppercase border ${SEVERITY_STYLES[rule.severity]} shrink-0`}>
          {rule.severity}
        </span>

        {/* Next evaluation */}
        <span className="text-[10px] text-[var(--color-outline)] min-w-max">
          {rule.state === 'disabled' ? '—' : nextEval(rule)}
        </span>
      </button>

      {/* Expanded detail section */}
      {expanded && (
        <div className="px-4 pb-3.5 pt-0 border-t border-[var(--color-surface-high)]">
          {/* Query */}
          <div className="mt-3">
            <span className="text-[10px] text-[var(--color-outline)] uppercase tracking-wider font-medium">Condition</span>
            <p className="mt-1 text-sm text-[var(--color-on-surface-variant)] font-mono bg-[#0B0B14] rounded-md px-3 py-2 break-all">
              {rule.condition.query.includes(String(rule.condition.threshold))
                ? rule.condition.query
                : `${rule.condition.query} ${rule.condition.operator} ${rule.condition.threshold}`}
              {rule.condition.forDurationSec > 0 ? ` for ${rule.condition.forDurationSec}s` : ''}
            </p>
          </div>

          {/* Description */}
          {rule.description && (
            <p className="text-xs text-[var(--color-on-surface-variant)] mt-3">{rule.description}</p>
          )}

          {/* Stats grid */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mt-3">
            <div className="bg-[var(--color-surface-high)] rounded-lg px-3 py-2">
              <span className="text-[10px] text-[var(--color-on-surface-variant)] uppercase tracking-wide">Interval</span>
              <div className="text-sm font-medium text-[var(--color-on-surface)] mt-0.5">{rule.evaluationIntervalSec}s</div>
            </div>
            <div className="bg-[var(--color-surface-high)] rounded-lg px-3 py-2">
              <span className="text-[10px] text-[var(--color-on-surface-variant)] uppercase tracking-wide">Last Check</span>
              <div className="text-sm font-medium text-[var(--color-on-surface)] mt-0.5">{rule.lastEvaluatedAt ? relativeTime(rule.lastEvaluatedAt) : 'Never'}</div>
            </div>
            <div className="bg-[var(--color-surface-high)] rounded-lg px-3 py-2">
              <span className="text-[10px] text-[var(--color-on-surface-variant)] uppercase tracking-wide">Times Fired</span>
              <div className="text-sm font-medium text-[var(--color-on-surface)] mt-0.5">{rule.fireCount}</div>
            </div>
            <div className="bg-[var(--color-surface-high)] rounded-lg px-3 py-2">
              <span className="text-[10px] text-[var(--color-on-surface-variant)] uppercase tracking-wide">State</span>
              <div className={`text-sm font-medium mt-0.5 ${stateStyle.text}`}>{stateStyle.label}</div>
            </div>
          </div>

          {/* Labels */}
          {Object.keys(rule.labels).length > 0 && (
            <div className="flex flex-wrap gap-1 mt-3">
              {Object.entries(rule.labels).map(([k, v]) => (
                <span key={k} className="px-2 py-0.5 rounded bg-[var(--color-surface-high)] text-[10px] text-[var(--color-on-surface-variant)] font-mono">
                  {k}={v}
                </span>
              ))}
            </div>
          )}

          {/* Original prompt */}
          {rule.originalPrompt && (
            <div className="mt-3">
              <span className="text-[10px] text-[var(--color-on-surface-variant)] uppercase tracking-wide font-medium">Created from prompt</span>
              <p className="text-xs text-[var(--color-on-surface-variant)] italic mt-0.5">{rule.originalPrompt}</p>
            </div>
          )}

          {/* Actions bar */}
          <div className="flex items-center gap-3 pt-4 border-t border-[var(--color-surface-high)] mt-3">
            <button
              type="button"
              onClick={async () => {
                if (dashboardId) {
                  const res = await apiClient.get(`/dashboards/${dashboardId}`);
                  if (!res.error) {
                    navigate(`/dashboards/${dashboardId}`);
                    return;
                  }
                }
                const prompt = rule.description || `Monitor ${humanizeName(rule.name)}`;
                navigate('/', { state: { initialPrompt: prompt } });
              }}
              className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium bg-[var(--color-primary)]/10 text-[var(--color-primary)] hover:bg-[var(--color-primary)]/20 transition-colors"
            >
              Dashboard
            </button>

            {(rule.state === 'firing' || rule.state === 'pending') && !rule.investigationId && (
              <button
                type="button"
                onClick={onInvestigate}
                disabled={investigating}
                className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium bg-[var(--color-primary)]/10 text-[var(--color-primary)] hover:bg-[var(--color-primary)]/20 transition-colors disabled:opacity-50"
              >
                {investigating ? 'Starting…' : 'Investigate'}
              </button>
            )}

            {rule.investigationId && (
              <button
                type="button"
                onClick={() => navigate(`/investigations/${rule.investigationId}`)}
                className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium bg-[var(--color-primary)]/10 text-[var(--color-primary)] hover:bg-[var(--color-primary)]/20 transition-colors"
              >
                View Investigation
              </button>
            )}

            {(rule.state === 'firing' || rule.state === 'pending') && (
              <button
                type="button"
                onClick={onInvestigate}
                disabled={investigating}
                className="px-2.5 py-1.5 rounded-lg text-xs text-[var(--color-outline)] hover:text-[var(--color-on-surface-variant)] hover:bg-[var(--color-surface-high)] transition-colors disabled:opacity-50"
              >
                {investigating ? 'Starting…' : 'Re-investigate'}
              </button>
            )}

            <div className="flex-1" />

            <button
              type="button"
              onClick={onToggleState}
              className="px-2.5 py-1.5 rounded-lg text-xs font-medium text-[var(--color-on-surface-variant)] hover:bg-[var(--color-surface-high)] transition-colors"
            >
              {isDisabled ? 'Enable' : 'Disable'}
            </button>

            <button
              type="button"
              onClick={onDelete}
              className="px-2.5 py-1.5 rounded-lg text-xs text-[var(--color-outline)] hover:text-[#EF4444] hover:bg-[#EF4444]/10 transition-colors"
            >
              Delete
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

export default function Alerts() {
  const navigate = useNavigate();
  const [rules, setRules] = useState<AlertRule[]>([]);
  const [loading, setLoading] = useState(true);
  const [stateFilter, setStateFilter] = useState<AlertRuleState | 'all'>('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  const [groupBy, setGroupBy] = useState<'none' | 'severity'>('none');
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [investigatingId, setInvestigatingId] = useState<string | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  // Keyboard shortcut: / to focus search
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === '/' && (document.activeElement?.tagName !== 'INPUT')) {
        e.preventDefault();
        searchRef.current?.focus();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  const loadRules = useCallback(async () => {
    const params = new URLSearchParams();
    if (stateFilter !== 'all') params.set('state', stateFilter);
    const qs = params.toString() ? `?${params.toString()}` : '';
    const res = await apiClient.get<{ list: AlertRule[]; total: number }>(`/alert-rules${qs}`);
    if (!res.error) setRules(res.data.list ?? []);
    setLoading(false);
  }, [stateFilter]);

  useEffect(() => {
    void loadRules();
    const timer = setInterval(() => { void loadRules(); }, 10_000);
    return () => clearInterval(timer);
  }, [loadRules]);

  const handleToggle = useCallback(async (rule: AlertRule) => {
    const nextState = rule.state === 'disabled' ? 'enable' : 'disable';
    const res = await apiClient.post<AlertRule>(`/alert-rules/${rule.id}/${nextState}`, {});
    if (!res.error) {
      setRules((prev) => prev.map((r) => r.id === rule.id ? res.data : r));
    }
  }, []);

  const handleDelete = useCallback(async (id: string) => {
    const res = await apiClient.delete(`/alert-rules/${id}`);
    if (!res.error) setRules((prev) => prev.filter((r) => r.id !== id));
  }, []);

  const handleInvestigate = useCallback(async (rule: AlertRule) => {
    setInvestigatingId(rule.id);
    const force = !rule.investigationId;
    const res = await apiClient.post<{ investigationId: string; prompt: string; existing: boolean }>(
      `/alert-rules/${rule.id}/investigate`,
      { force },
    );
    setInvestigatingId(null);
    if (!res.error && res.data.investigationId) {
      setRules((prev) => prev.map((r) => r.id === rule.id ? { ...r, investigationId: res.data.investigationId } : r));
      navigate(`/investigations/${res.data.investigationId}`);
    }
  }, [navigate]);

  const toggleExpand = useCallback((id: string) => {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  // Filtering & search
  const filteredRules = useMemo(() => {
    if (!searchQuery.trim()) return rules;
    const q = searchQuery.toLowerCase();
    return rules.filter((r) =>
      r.name.toLowerCase().includes(q) ||
      r.condition.query.toLowerCase().includes(q) ||
      r.description.toLowerCase().includes(q) ||
      r.severity.includes(q) ||
      Object.values(r.labels).some((v) => v.toLowerCase().includes(q))
    );
  }, [rules, searchQuery]);

  // Counts (from all rules, not filtered)
  const counts = useMemo(() => {
    const c = { total: rules.length, firing: 0, pending: 0, normal: 0, disabled: 0, error: 0 };
    for (const r of rules) {
      if (r.state === 'firing') c.firing++;
      else if (r.state === 'pending') c.pending++;
      else if (r.state === 'disabled') c.disabled++;
      else c.normal++;
      if (r.state === 'firing') c.error++;
    }
    return c;
  }, [rules]);

  // Grouping
  const groups = useMemo(() => {
    if (groupBy === 'none') return [{ key: '', label: '', rules: filteredRules }];
    const map = new Map<AlertSeverity, AlertRule[]>();
    const order: AlertSeverity[] = ['critical', 'high', 'medium', 'low'];
    for (const r of filteredRules) {
      const arr = map.get(r.severity) ?? [];
      arr.push(r);
      map.set(r.severity, arr);
    }
    return [...map.entries()]
      .filter(([, rules]) => rules.length > 0)
      .sort(([a], [b]) => order.indexOf(a) - order.indexOf(b))
      .map(([key, rules]) => ({ key, label: key.charAt(0).toUpperCase() + key.slice(1), rules }));
  }, [filteredRules, groupBy]);

  const STATE_TABS: Array<{ value: AlertRuleState | 'all'; label: string; count?: number; color?: string }> = [
    { value: 'all', label: 'All', count: counts.total },
    { value: 'firing', label: 'Firing', count: counts.firing, color: '#EF4444' },
    { value: 'pending', label: 'Pending', count: counts.pending, color: '#F59E0B' },
    { value: 'normal', label: 'Normal', count: counts.normal, color: '#22C55E' },
    { value: 'disabled', label: 'Disabled', count: counts.disabled },
  ];

  return (
    <div className="flex-1 overflow-y-auto bg-surface-lowest">
      <div className="p-8 max-w-5xl mx-auto">
        {/* Header */}
        <div className="flex items-center justify-between mb-8">
          <div>
            <h1 className="text-3xl font-bold tracking-tight text-on-surface font-[Manrope]">Alerts</h1>
            <p className="text-on-surface-variant mt-1 text-sm">Monitor and manage alert rules.</p>
          </div>
          <div className="flex items-center gap-4">
            <div className="flex flex-wrap items-center gap-2">
              {counts.firing > 0 && <span className="px-2 py-0.5 rounded text-[11px] font-bold bg-error/15 text-error">{counts.firing} firing</span>}
              {counts.pending > 0 && <span className="px-2 py-0.5 rounded text-[11px] font-bold bg-amber-400/15 text-amber-400">{counts.pending} pending</span>}
              {counts.normal > 0 && <span className="px-2 py-0.5 rounded text-[11px] font-bold bg-secondary/10 text-secondary">{counts.normal} normal</span>}
            </div>
            <button
              type="button"
              onClick={() => navigate('/')}
              className="bg-primary text-on-primary-fixed px-4 py-2 rounded-lg font-semibold text-sm transition-transform active:scale-95"
            >
              + Create Rule
            </button>
          </div>
        </div>

        {/* Search / Filter bar */}
        <div className="flex flex-col sm:flex-row gap-3 mb-4">
          {/* Search */}
          <div className="relative flex-1">
            <svg className="absolute left-3 top-1/2 -translate-y-1/2 text-[var(--color-outline)]" width="20" height="20" viewBox="0 0 20 20" fill="none">
              <path d="M14.31 14.31l3.69 3.69" stroke="currentColor" strokeWidth={2} strokeLinecap="round" />
              <circle cx="9" cy="9" r="5.75" stroke="currentColor" strokeWidth={2} />
            </svg>
            <input
              ref={searchRef}
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search rules, queries, labels…"
              className="w-full bg-surface-high rounded-lg pl-10 pr-9 py-2.5 text-sm text-on-surface placeholder:text-on-surface-variant/60 outline-none focus:ring-1 focus:ring-primary border-none"
            />
            {searchQuery && (
              <button
                type="button"
                onClick={() => setSearchQuery('')}
                className="absolute right-2.5 top-1/2 -translate-y-1/2 text-[var(--color-outline)] hover:text-[var(--color-on-surface-variant)]"
              >
                ×
              </button>
            )}
          </div>

          {/* State filter pills */}
          <div className="flex gap-1 bg-surface-high rounded-lg p-0.5 shrink-0">
            {STATE_TABS.map((tab) => (
              <button
                key={tab.value}
                type="button"
                onClick={() => setStateFilter(tab.value)}
                className={`px-2.5 py-1.5 rounded-md text-xs font-medium transition-colors ${
                  stateFilter === tab.value
                    ? 'bg-[var(--color-surface-high)] text-[var(--color-on-surface)]'
                    : 'text-[var(--color-outline)] hover:text-[var(--color-on-surface-variant)]'
                }`}
              >
                {tab.label}
                {tab.count !== undefined && (
                  <span className="ml-1.5" style={{ color: tab.color ?? undefined }}>
                    {tab.count}
                  </span>
                )}
              </button>
            ))}
          </div>

          {/* Group by toggle */}
          <div className="flex gap-1 bg-surface-high rounded-lg p-0.5 shrink-0">
            <button
              type="button"
              onClick={() => setGroupBy('none')}
              className={`px-2.5 py-1.5 rounded-md text-xs font-medium transition-colors ${groupBy === 'none' ? 'bg-[var(--color-surface-high)] text-[var(--color-on-surface)]' : 'text-[var(--color-outline)] hover:text-[var(--color-on-surface-variant)]'}`}
            >
              List
            </button>
            <button
              type="button"
              onClick={() => setGroupBy('severity')}
              className={`px-2.5 py-1.5 rounded-md text-xs font-medium transition-colors ${groupBy === 'severity' ? 'bg-[var(--color-surface-high)] text-[var(--color-on-surface)]' : 'text-[var(--color-outline)] hover:text-[var(--color-on-surface-variant)]'}`}
            >
              Grouped
            </button>
          </div>
        </div>

        {/* Loading */}
        {loading && (
          <div className="flex justify-center py-16">
            <span className="inline-block w-5 h-5 border-2 border-[var(--color-outline-variant)] border-t-[var(--color-primary)] rounded-full animate-spin" />
          </div>
        )}

        {/* Empty state */}
        {!loading && !rules.length && (
          <div className="flex flex-col items-center justify-center py-20 text-center">
            <div className="w-12 h-12 rounded-full bg-[var(--color-surface-highest)] border border-[var(--color-outline-variant)] flex items-center justify-center mb-4">
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v4m0 4h.01M10.29 3.86l-7.1 12.3A2 2 0 004.92 19h14.16a2 2 0 001.73-2.84l-7.1-12.3a2 2 0 00-3.46 0z" stroke="var(--color-primary)" strokeWidth="1.8"/>
              </svg>
            </div>
            <div className="text-sm text-[var(--color-on-surface-variant)] mb-1">No alert rules yet</div>
            <p className="text-xs text-[var(--color-outline)]">Create your first alert rule using the + Create Rule button above</p>
          </div>
        )}

        {/* No search results */}
        {!loading && rules.length > 0 && !filteredRules.length && (
          <div className="flex flex-col items-center py-12 text-center">
            <span className="text-[var(--color-on-surface-variant)]">No rules match "{searchQuery}"</span>
            <button
              type="button"
              onClick={() => setSearchQuery('')}
              className="mt-2 text-xs text-[var(--color-primary)] hover:opacity-80"
            >
              Clear search
            </button>
          </div>
        )}

        {/* Rule list */}
        {!loading && filteredRules.length > 0 && (
          <div className="space-y-6">
            {groups.map((group) => (
              <div key={group.key || '__all'}>
                {group.label && (
                  <div className="flex items-center gap-3 mb-2 mt-2">
                    <span className={`px-2 py-0.5 rounded text-[11px] font-bold uppercase ${SEVERITY_STYLES[group.key as AlertSeverity]}`}>
                      {group.label}
                    </span>
                    <div className="flex-1 h-px bg-[var(--color-surface-high)]" />
                    <span className="text-[11px] text-[var(--color-outline)]">{group.rules.length} rule{group.rules.length === 1 ? '' : 's'}</span>
                  </div>
                )}

                <div className="space-y-2">
                  {group.rules.map((rule) => (
                    <AlertRuleRow
                      key={rule.id}
                      rule={rule}
                      expanded={expandedIds.has(rule.id)}
                      onToggleExpand={() => toggleExpand(rule.id)}
                      onToggleState={() => void handleToggle(rule)}
                      onDelete={() => setDeletingId(rule.id)}
                      onInvestigate={() => void handleInvestigate(rule)}
                      investigating={investigatingId === rule.id}
                      navigate={navigate}
                    />
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}

        <ConfirmDialog
          open={deletingId !== null}
          title="Delete alert rule?"
          message="This alert rule and its evaluation history will be permanently deleted."
          onConfirm={() => {
            if (deletingId) void handleDelete(deletingId);
            setDeletingId(null);
          }}
          onCancel={() => setDeletingId(null)}
        />
      </div>
    </div>
  );
}
