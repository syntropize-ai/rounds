import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { apiClient } from '../api/client.js';
import Skeleton from '../components/Skeleton.js';

export type PreviewResult =
  | { kind: 'ok'; wouldHaveFired: number; sampleTimestamps: string[]; seriesCount: number; lookbackHours: number; reason?: 'no_series' }
  | { kind: 'missing_capability'; reason: string };

export type PreviewState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'success'; data: PreviewResult }
  | { status: 'error'; message: string };

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
  condition: AlertCondition;
  evaluationIntervalSec: number;
  severity: AlertSeverity;
  labels: Record<string, string>;
}

interface FormState {
  name: string;
  description: string;
  query: string;
  operator: string;
  threshold: number;
  forDurationSec: number;
  evaluationIntervalSec: number;
  severity: AlertSeverity;
  labelsText: string;
}

function ruleToForm(rule: AlertRule): FormState {
  return {
    name: rule.name,
    description: rule.description ?? '',
    query: rule.condition.query,
    operator: rule.condition.operator,
    threshold: rule.condition.threshold,
    forDurationSec: rule.condition.forDurationSec,
    evaluationIntervalSec: rule.evaluationIntervalSec,
    severity: rule.severity,
    labelsText: Object.entries(rule.labels ?? {})
      .filter(([k]) => k !== 'workspaceId')
      .map(([k, v]) => `${k}=${v}`)
      .join('\n'),
  };
}

function parseLabels(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    const k = trimmed.slice(0, eq).trim();
    const v = trimmed.slice(eq + 1).trim();
    if (k) out[k] = v;
  }
  return out;
}

const inputCls = 'w-full px-3 py-2 rounded-lg border border-[var(--color-outline-variant)] bg-[var(--color-surface-lowest)] text-[var(--color-on-surface)] text-sm placeholder-[var(--color-outline)] focus:outline-none focus:border-[var(--color-primary)] transition-colors';

export default function AlertRuleEdit() {
  const { id = '' } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [form, setForm] = useState<FormState | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<PreviewState>({ status: 'idle' });
  const previewSeq = useRef(0);

  useEffect(() => {
    void apiClient.get<AlertRule>(`/alert-rules/${id}`).then((res) => {
      if (res.error) setError(res.error.message ?? 'Failed to load rule');
      else setForm(ruleToForm(res.data));
      setLoading(false);
    });
  }, [id]);

  // Debounced preview / backtest — fires whenever the predicate inputs
  // (query / operator / threshold) change. The sequence ref ignores stale
  // responses if the user keeps editing while a request is in flight.
  const previewKey = useMemo(() => {
    if (!form) return null;
    if (!form.query.trim() || !Number.isFinite(form.threshold)) return null;
    return JSON.stringify({ q: form.query, op: form.operator, t: form.threshold });
  }, [form]);

  useEffect(() => {
    if (!previewKey || !form) {
      setPreview({ status: 'idle' });
      return;
    }
    const seq = ++previewSeq.current;
    setPreview({ status: 'loading' });
    const handle = setTimeout(async () => {
      const res = await apiClient.post<PreviewResult>('/alert-rules/preview', {
        query: form.query,
        comparator: form.operator,
        threshold: Number(form.threshold),
        lookbackHours: 24,
      });
      if (seq !== previewSeq.current) return;
      if (res.error) {
        setPreview({ status: 'error', message: res.error.message ?? 'Preview failed' });
      } else {
        setPreview({ status: 'success', data: res.data });
      }
    }, 400);
    return () => clearTimeout(handle);
  }, [previewKey, form]);

  const handleSave = useCallback(async () => {
    if (!form) return;
    setSaving(true); setError(null);
    const body = {
      name: form.name,
      description: form.description,
      condition: {
        query: form.query,
        operator: form.operator,
        threshold: Number(form.threshold),
        forDurationSec: Number(form.forDurationSec),
      },
      evaluationIntervalSec: Number(form.evaluationIntervalSec),
      severity: form.severity,
      labels: parseLabels(form.labelsText),
    };
    const res = await apiClient.put(`/alert-rules/${id}`, body);
    setSaving(false);
    if (res.error) setError(res.error.message ?? 'Failed to save');
    else navigate('/alerts');
  }, [form, id, navigate]);

  if (loading) {
    return (
      <div className="flex-1 overflow-y-auto bg-surface-lowest">
        <div className="p-8 max-w-2xl mx-auto space-y-4" data-testid="alert-rule-edit-loading">
          <Skeleton variant="report-section" />
          <Skeleton variant="report-section" />
          <Skeleton variant="report-section" />
        </div>
      </div>
    );
  }

  if (!form) {
    return (
      <div className="p-8 max-w-2xl mx-auto">
        <p className="text-sm text-[#EF4444]">{error ?? 'Rule not found'}</p>
        <button type="button" onClick={() => navigate('/alerts')} className="mt-4 text-sm text-[var(--color-primary)]">Back to alerts</button>
      </div>
    );
  }

  const set = (patch: Partial<FormState>) => setForm((prev) => (prev ? { ...prev, ...patch } : prev));

  return (
    <div className="flex-1 overflow-y-auto bg-surface-lowest">
      <div className="p-8 max-w-2xl mx-auto">
        <div className="mb-6">
          <button type="button" onClick={() => navigate('/alerts')} className="text-xs text-[var(--color-outline)] hover:text-[var(--color-on-surface-variant)] mb-2">← Alerts</button>
          <h1 className="text-2xl font-bold text-[var(--color-on-surface)]">Edit alert rule</h1>
        </div>

        <div className="space-y-4">
          <div>
            <label className="block text-xs font-medium text-[var(--color-on-surface)] mb-1">Name</label>
            <input type="text" value={form.name} onChange={(e) => set({ name: e.target.value })} className={inputCls} />
          </div>

          <div>
            <label className="block text-xs font-medium text-[var(--color-on-surface)] mb-1">Description</label>
            <textarea value={form.description} onChange={(e) => set({ description: e.target.value })} rows={2} className={inputCls + ' resize-y'} />
          </div>

          <div>
            <label className="block text-xs font-medium text-[var(--color-on-surface)] mb-1">Query</label>
            <textarea value={form.query} onChange={(e) => set({ query: e.target.value })} rows={3} className={inputCls + ' font-mono text-xs resize-y'} />
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div>
              <label className="block text-xs font-medium text-[var(--color-on-surface)] mb-1">Operator</label>
              <select value={form.operator} onChange={(e) => set({ operator: e.target.value })} className={inputCls}>
                <option value=">">{'>'}</option>
                <option value=">=">{'>='}</option>
                <option value="<">{'<'}</option>
                <option value="<=">{'<='}</option>
                <option value="==">==</option>
                <option value="!=">!=</option>
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-[var(--color-on-surface)] mb-1">Threshold</label>
              <input type="number" value={form.threshold} onChange={(e) => set({ threshold: Number(e.target.value) })} className={inputCls} />
            </div>
            <div>
              <label className="block text-xs font-medium text-[var(--color-on-surface)] mb-1">For (sec)</label>
              <input type="number" value={form.forDurationSec} onChange={(e) => set({ forDurationSec: Number(e.target.value) })} className={inputCls} />
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-[var(--color-on-surface)] mb-1">Evaluation interval (sec)</label>
              <input type="number" value={form.evaluationIntervalSec} onChange={(e) => set({ evaluationIntervalSec: Number(e.target.value) })} className={inputCls} />
            </div>
            <div>
              <label className="block text-xs font-medium text-[var(--color-on-surface)] mb-1">Severity</label>
              <select value={form.severity} onChange={(e) => set({ severity: e.target.value as AlertSeverity })} className={inputCls}>
                <option value="critical">critical</option>
                <option value="high">high</option>
                <option value="medium">medium</option>
                <option value="low">low</option>
              </select>
            </div>
          </div>

          <div>
            <label className="block text-xs font-medium text-[var(--color-on-surface)] mb-1">Labels</label>
            <textarea value={form.labelsText} onChange={(e) => set({ labelsText: e.target.value })} rows={3} placeholder="key=value (one per line)" className={inputCls + ' font-mono text-xs resize-y'} />
          </div>

          <PreviewPane state={preview} threshold={form.threshold} />

          {error && <p className="text-xs text-[#EF4444]">{error}</p>}

          <div className="flex items-center gap-2 pt-3 border-t border-[var(--color-outline-variant)]/30">
            <button type="button" onClick={() => navigate('/alerts')} className="px-3 py-2 rounded-lg text-sm text-[var(--color-on-surface-variant)] hover:bg-[var(--color-surface-high)]">Cancel</button>
            <div className="flex-1" />
            <button type="button" onClick={() => void handleSave()} disabled={saving || !form.name || !form.query} className="px-4 py-2 rounded-lg bg-[var(--color-primary)] text-[var(--color-on-primary-fixed)] text-sm font-medium hover:opacity-90 disabled:opacity-40 transition-opacity">
              {saving ? 'Saving...' : 'Save'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

interface PreviewPaneProps {
  state: PreviewState;
  threshold: number;
}

/**
 * Preview / backtest pane for the alert condition editor. Renders four
 * mutually exclusive states:
 *   - loading
 *   - missing_capability (no metrics datasource configured)
 *   - no_series / no_data (datasource present, query returned nothing)
 *   - success (count + sparkline-like list of recent matches)
 */
export function PreviewPane({ state, threshold }: PreviewPaneProps): React.ReactElement | null {
  if (state.status === 'idle') return null;

  return (
    <div
      data-testid="alert-preview-pane"
      className="rounded-lg border border-[var(--color-outline-variant)] bg-[var(--color-surface-low)] p-3"
    >
      <div className="text-xs font-medium text-[var(--color-on-surface)] mb-2">Preview (last 24h)</div>
      {state.status === 'loading' && (
        <p data-testid="alert-preview-loading" className="text-xs text-[var(--color-on-surface-variant)]">
          Backtesting condition...
        </p>
      )}
      {state.status === 'error' && (
        <p data-testid="alert-preview-error" className="text-xs text-[#EF4444]">
          {state.message}
        </p>
      )}
      {state.status === 'success' && state.data.kind === 'missing_capability' && (
        <p data-testid="alert-preview-missing" className="text-xs text-[var(--color-on-surface-variant)]">
          Preview unavailable: {state.data.reason === 'no_metrics_datasource'
            ? 'no metrics datasource is configured.'
            : state.data.reason}
        </p>
      )}
      {state.status === 'success' && state.data.kind === 'ok' && state.data.reason === 'no_series' && (
        <p data-testid="alert-preview-no-data" className="text-xs text-[var(--color-on-surface-variant)]">
          No series returned by the query in the last {state.data.lookbackHours}h.
        </p>
      )}
      {state.status === 'success' && state.data.kind === 'ok' && state.data.reason !== 'no_series' && (
        <div data-testid="alert-preview-success">
          <div className="text-sm text-[var(--color-on-surface)]">
            <span data-testid="alert-preview-fired-count" className="font-semibold">
              Would have fired {state.data.wouldHaveFired} time{state.data.wouldHaveFired === 1 ? '' : 's'}
            </span>{' '}
            in the last {state.data.lookbackHours}h across {state.data.seriesCount} series (threshold {threshold}).
          </div>
          {state.data.sampleTimestamps.length > 0 && (
            <ul className="mt-2 text-[11px] text-[var(--color-on-surface-variant)] font-mono space-y-0.5 max-h-32 overflow-y-auto">
              {state.data.sampleTimestamps.slice(0, 8).map((ts) => (
                <li key={ts}>• {ts}</li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
