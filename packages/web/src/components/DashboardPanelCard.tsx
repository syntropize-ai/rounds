import React, { useEffect, useState, useCallback, useRef, useMemo } from 'react';
import { apiClient } from '../api/client.js';
import { queryScheduler } from '../api/query-scheduler.js';
import TimeSeriesChart from './TimeSeriesChart.js';
import StatVisualization from './StatVisualization.js';
import GaugeVisualization from './GaugeVisualization.js';
import BarVisualization from './BarVisualization.js';
import PieVisualization from './PieVisualization.js';
import HistogramVisualization from './HistogramVisualization.js';
import HeatmapVisualization from './HeatmapVisualization.js';
import StatusTimelineVisualization from './StatusTimelineVisualization.js';

// Types

export interface PanelQuery {
  refId: string;
  expr: string;
  legendFormat?: string;
  instant?: boolean;
  datasourceId?: string;
}

export interface PanelThreshold {
  value: number;
  color: string;
  label?: string;
}

export interface PanelConfig {
  id: string;
  title: string;
  description?: string;
  queries?: PanelQuery[];
  visualization:
    | 'time_series'
    | 'stat'
    | 'table'
    | 'gauge'
    | 'bar'
    | 'pie'
    | 'histogram'
    | 'heatmap'
    | 'status_timeline';
  unit?: string;
  refreshIntervalSec?: number | null;
  thresholds?: PanelThreshold[];
  stackMode?: 'normal' | 'percent';
  fillOpacity?: number;
  decimals?: number;
  // Backward compat: v1 panels use single query string
  query?: string;
  // Grid placement - backend uses row/col/width/height, frontend aliases gridRow etc.
  row?: number;
  col?: number;
  width?: number;
  height?: number;
  gridRow?: number;
  gridCol?: number;
  gridWidth?: number;
  gridHeight?: number;
  // Section grouping
  sectionId?: string;
  sectionLabel?: string;
}

interface PrometheusRangeResult {
  metric: Record<string, string>;
  values: [number, string][];
}

interface PrometheusInstantResult {
  metric: Record<string, string>;
  value: [number, string];
}

interface RangeResponse {
  status: string;
  data: { result: PrometheusRangeResult[] };
}

interface InstantResponse {
  status: string;
  data: { result: PrometheusInstantResult[] };
}

// Helpers

interface QueryResult {
  refIds: string;
  legendFormat?: string;
  series: Array<{ labels: Record<string, string>; points: Array<{ ts: number; value: number }> }>;
  totalSeries: number;
  error?: string;
}

function transformQueryResult(data: RangeResponse, pq: PanelQuery): QueryResult {
  const results = data?.data?.result ?? [];
  return {
    refIds: pq.refId,
    legendFormat: pq.legendFormat,
    series: results.map((r) => ({
      labels: r.metric,
      points: (r.values ?? []).map(([ts, val]) => ({ ts: ts * 1000, value: Number.parseFloat(val) })),
    })),
    totalSeries: results.length,
  };
}

function transformInstantData(data: InstantResponse, query: string) {
  return {
    query,
    series: data.data.result.map((r) => ({
      labels: r.metric,
      points: [{ ts: r.value[0] * 1000, value: Number.parseFloat(r.value[1]) }],
    })),
    totalSeries: data.data.result.length,
  };
}

function firstInstantValue(data: InstantResponse | null): number {
  const raw = data?.data?.result?.[0]?.value?.[1];
  return raw === undefined ? 0 : Number.parseFloat(raw);
}

function instantToBarItems(data: InstantResponse | null): Array<{ label: string; value: number }> {
  if (!data) return [];
  return data.data.result.map((r) => {
    const labelEntries = Object.entries(r.metric).filter(([k]) => k !== '__name__');
    const label =
      labelEntries.length > 0
        ? labelEntries.slice(0, 2).map(([, v]) => v).join('/')
        : r.metric['__name__'] ?? 'series';
    return { label, value: Number.parseFloat(r.value[1]) };
  });
}

function instantToPieItems(data: InstantResponse | null): Array<{ label: string; value: number }> {
  if (!data) return [];
  return data.data.result.map((r) => {
    const labelEntries = Object.entries(r.metric).filter(([k]) => k !== '__name__');
    const label =
      labelEntries.length > 0
        ? labelEntries.slice(0, 2).map(([, v]) => v).join('/')
        : r.metric['__name__'] ?? 'series';
    return { label, value: Number.parseFloat(r.value[1]) };
  });
}

function instantToHistogramBuckets(data: InstantResponse | null): Array<{ le: string; count: number }> {
  if (!data) return [];
  return data.data.result
    .filter((r) => r.metric['le'] != null)
    .map((r) => ({ le: r.metric['le']!, count: Number.parseFloat(r.value[1]) }))
    .sort((a, b) => {
      const an = a.le === '+Inf' ? Infinity : Number.parseFloat(a.le);
      const bn = b.le === '+Inf' ? Infinity : Number.parseFloat(b.le);
      return an - bn;
    });
}

function rangeToHeatmapPoints(results: QueryResult[]): Array<{ x: number; y: string; value: number }> {
  const points: Array<{ x: number; y: string; value: number }> = [];
  for (const qr of results) {
    for (const s of qr.series) {
      const le = s.labels['le'];
      let yLabel: string;
      if (le != null) {
        yLabel = le;
      } else {
        const entries = Object.entries(s.labels).filter(([k]) => k !== '__name__');
        yLabel =
          entries.length > 0
            ? entries.slice(0, 2).map(([, v]) => v).join('/')
            : s.labels['__name__'] ?? 'series';
      }
      for (const p of s.points) {
        points.push({ x: p.ts, y: yLabel, value: p.value });
      }
    }
  }
  return points;
}

function rangeToStatusSpans(results: QueryResult[]): Array<{ label: string; start: number; end: number; status: string }> {
  const spans: Array<{ label: string; start: number; end: number; status: string }> = [];
  for (const qr of results) {
    for (const s of qr.series) {
      const labelEntries = Object.entries(s.labels).filter(([k]) => k !== '__name__');
      const label =
        labelEntries.length > 0
          ? labelEntries.slice(0, 2).map(([, v]) => v).join('/')
          : s.labels['__name__'] ?? 'series';
      let spanStart = 0;
      let lastStatus = '';
      for (let i = 0; i < s.points.length; i += 1) {
        const p = s.points[i]!;
        const status = p.value === 1 ? 'up' : p.value === 0 ? 'down' : String(p.value);
        if (i === 0) {
          lastStatus = status;
          spanStart = p.ts;
        } else if (status !== lastStatus) {
          spans.push({ label, start: spanStart, end: p.ts, status: lastStatus });
          spanStart = p.ts;
          lastStatus = status;
        }
      }
      if (s.points.length > 0) {
        const last = s.points[s.points.length - 1]!;
        spans.push({ label, start: spanStart, end: last.ts, status: lastStatus });
      }
    }
  }
  return spans;
}

// Error helpers

/** Extract a human-readable message from apiClient's nested error objects */
function extractErrorMessage(err: unknown): string {
  if (!err || typeof err !== 'object') return 'Query failed';
  const obj = err as Record<string, unknown>;
  if (typeof obj.message === 'string') return obj.message;
  if (obj.error && typeof obj.error === 'object') {
    const inner = obj.error as Record<string, unknown>;
    if (typeof inner.message === 'string') return inner.message;
  }
  if (typeof obj.code === 'string') return `${obj.code}: ${String(obj.message ?? 'unknown error')}`;
  return 'Query failed';
}

// Spinner

function Spinner() {
  return (
    <span className="inline-block w-3.5 h-3.5 border-2 border-outline-variant border-t-primary rounded-full animate-spin" />
  );
}

// PromQL query display

function QueryBadge({ queries }: { queries: PanelQuery[] }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <div className="bg-surface-high px-4 py-1.5">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="text-[11px] text-on-surface-variant hover:text-on-surface flex items-center gap-1 transition-colors"
      >
        <span className="font-mono">PromQL</span>
        {queries.length > 1 && (
          <span className="text-[10px] bg-primary/20 text-primary px-1.5 py-0.5 rounded font-mono">
            {queries.length}
          </span>
        )}
        <svg
          className={`w-3 h-3 transition-transform ${expanded ? 'rotate-180' : ''}`}
          viewBox="0 0 20 20"
          fill="currentColor"
        >
          <path fillRule="evenodd" d="M5.23 7.21a.75.75 0 011.06.02L10 11.17l3.71-3.94a.75.75 0 111.08 1.04l-4.25 4.5a.75.75 0 01-1.08 0l-4.25-4.5a.75.75 0 01.02-1.06z" clipRule="evenodd" />
        </svg>
      </button>
      {expanded && (
        <div className="mt-1.5 space-y-1.5">
          {queries.map((q) => (
            <div key={q.refId}>
              {queries.length > 1 && (
                <span className="text-[10px] text-primary font-medium">{q.refId}</span>
              )}
              <pre className="inline-block w-full text-[11px] font-mono text-on-surface bg-surface-lowest rounded p-2 overflow-x-auto whitespace-pre-wrap break-all">
                {q.expr}
              </pre>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** Convert a relative time range string to {start, end} ISO timestamps */
function resolveTimeRange(range: string): { start: string; end: string } {
  const end = new Date();
  let ms = 30 * 60 * 1000; // default 30m
  const match = range.match(/^(\d+)(m|h|d)$/);
  if (match) {
    const [, n, unit] = match;
    const num = parseInt(n ?? '30', 10);
    if (unit === 'm') ms = num * 60 * 1000;
    else if (unit === 'h') ms = num * 3600 * 1000;
    else if (unit === 'd') ms = num * 86400 * 1000;
  } else if (range.includes('|')) {
    // Custom: "2024-01-01T00:00|2024-01-02T00:00"
    const parts = range.split('|');
    return { start: new Date(parts[0] ?? '').toISOString(), end: new Date(parts[1] ?? '').toISOString() };
  }
  return { start: new Date(end.getTime() - ms).toISOString(), end: end.toISOString() };
}

interface Props {
  panel: PanelConfig;
  onEdit?: () => void;
  onDelete?: () => void;
  editMode?: boolean;
  timeRange?: string;
}

export default function DashboardPanelCard({
  panel,
  onEdit,
  onDelete,
  editMode = false,
  timeRange = '1h',
}: Props) {
  const [loading, setLoading] = useState(true);
  const [multiRangeData, setMultiRangeData] = useState<QueryResult[]>([]);
  const [instantData, setInstantData] = useState<InstantResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isTransientError, setIsTransientError] = useState(false);

  const retryCountRef = useRef(0);
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const effectiveQueries = useMemo<PanelQuery[]>(
    () =>
      panel.queries && panel.queries.length > 0
        ? panel.queries
        : panel.query
          ? [{ refId: 'A', expr: panel.query, instant: panel.visualization !== 'time_series' }]
          : [],
    [panel.queries, panel.query, panel.visualization]
  );

  const isRangeViz = panel.visualization === 'time_series' || panel.visualization === 'status_timeline' || panel.visualization === 'heatmap';
  const activeQuery = effectiveQueries[0]?.expr ?? '';

  // Build a stable dedup key from queries
  const queryKey = useMemo(
    () => effectiveQueries.map((q) => q.expr).join('|') + `@${timeRange}`,
    [effectiveQueries, timeRange]
  );

  const cacheMaxAgeMs = (panel.refreshIntervalSec ?? 30) * 1000;

  /** Returns true if the error message / object looks like a transient failure */
  function isTransientMsg(msg: string): boolean {
    return /too many requests|rate.?limit|429|503|502|network/i.test(msg);
  }

  const fetchData = useCallback(
    async (isRetry = false) => {
      if (effectiveQueries.length === 0) {
        setLoading(false);
        return;
      }

      if (isRetry) {
        setError(null);
        setIsTransientError(false);
      }

      const hasExistingData = multiRangeData.length > 0 || instantData !== null;

      const handleError = (msg: string) => {
        const transient = isTransientMsg(msg);
        // If we already have data, silently ignore transient errors - keep showing stale data.
        if (transient && hasExistingData) {
          retryCountRef.current = 0;
          setLoading(false);
          return;
        }
        if (transient && retryCountRef.current < 4) {
          const delayMs = Math.min(1000 * 2 ** retryCountRef.current, 16000);
          retryCountRef.current += 1;
          retryTimerRef.current = setTimeout(() => void fetchData(true), delayMs);
          return;
        }
        retryCountRef.current = 0;
        setIsTransientError(transient);
        setError(msg);
        setLoading(false);
      };

      if (isRangeViz) {
        try {
          const batchRes = await queryScheduler.schedule<{
            data: { results: Record<string, { status: string; data: RangeResponse; error?: string }> } | null;
            error?: unknown;
          }>(
            `batch:${queryKey}`,
            () =>
              apiClient.post('/query/batch', {
                queries: effectiveQueries.map((q) => ({ refId: q.refId, expr: q.expr, instant: q.instant })),
                ...resolveTimeRange(timeRange),
              }) as Promise<{
                data: { results: Record<string, { status: string; data: RangeResponse; error?: string }> } | null;
                error?: unknown;
              }>
          );

          if (batchRes.error) {
            handleError(extractErrorMessage(batchRes.error));
            return;
          }
          if (!batchRes.data?.results) {
            handleError('Empty response from query API');
            return;
          }

          retryCountRef.current = 0;
          const results = effectiveQueries.map((pq) => {
            const rr = batchRes.data!.results[pq.refId];
            if (!rr || rr.status === 'error') {
              return {
                refIds: pq.refId,
                legendFormat: pq.legendFormat,
                series: [],
                totalSeries: 0,
                error: rr?.error ?? 'Query failed',
              };
            }
            return transformQueryResult(rr.data, pq);
          });
          setMultiRangeData(results);
        } catch (err) {
          handleError(err instanceof Error ? err.message : 'Query failed');
          return;
        }
      } else {
        try {
          const res = await queryScheduler.schedule<{ data: InstantResponse | null; error?: unknown }>(
            `instant:${activeQuery}`,
            () =>
              apiClient.post('/query/instant', { query: activeQuery }) as Promise<{
                data: InstantResponse | null;
                error?: unknown;
              }>
          );
          if (res.error) {
            handleError(extractErrorMessage(res.error));
            return;
          }
          retryCountRef.current = 0;
          setInstantData(res.data);
        } catch (err) {
          handleError(err instanceof Error ? err.message : 'Query failed');
          return;
        }
      }

      setLoading(false);
    },
    [effectiveQueries, isRangeViz, activeQuery, queryKey, cacheMaxAgeMs, multiRangeData.length, instantData, panel.refreshIntervalSec]
  );

  // Try to restore from cache without fetching
  const restoreFromCache = useCallback(() => {
    const cacheKey = isRangeViz ? `batch:${queryKey}` : `instant:${activeQuery}`;
    const cached = queryScheduler.getCached<unknown>(cacheKey, cacheMaxAgeMs);
    if (!cached) return false;

    if (isRangeViz) {
      const batchData = cached as {
        data: { results: Record<string, { status: string; data: RangeResponse; error?: string }> } | null;
      };
      if (!batchData?.data?.results) return false;
      const results = effectiveQueries.map((pq) => {
        const rr = batchData.data!.results[pq.refId];
        if (!rr || rr.status === 'error') {
          return { refIds: pq.refId, legendFormat: pq.legendFormat, series: [], totalSeries: 0 };
        }
        return transformQueryResult(rr.data, pq);
      });
      setMultiRangeData(results);
    } else {
      const res = cached as { data: InstantResponse };
      setInstantData(res.data);
    }

    setLoading(false);
    return true;
  }, [isRangeViz, queryKey, activeQuery, cacheMaxAgeMs, effectiveQueries]);

  useEffect(() => {
    setError(null);
    setIsTransientError(false);
    setMultiRangeData([]);
    setInstantData(null);
    retryCountRef.current = 0;

    // On mount: use cached data if available - no network request
    if (!restoreFromCache()) {
      // First-ever load (no cache) - must fetch
      setLoading(true);
      void fetchData();
    }

    // Interval timer - jitter by +/-20% so panels don't all refresh at the same instant.
    const intervalSec = panel.refreshIntervalSec ?? 30;
    const jitter = intervalSec * 1000 * (0.8 + Math.random() * 0.4);
    intervalRef.current = setInterval(() => {
      retryCountRef.current = 0;
      void fetchData();
    }, jitter);

    // Listen for explicit refresh from workspace
    const handleRefresh = () => {
      retryCountRef.current = 0;
      if (retryTimerRef.current) {
        clearTimeout(retryTimerRef.current);
        retryTimerRef.current = null;
      }
      void fetchData();
    };
    window.addEventListener('dashboard:refresh-panels', handleRefresh as EventListener);

    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
      if (retryTimerRef.current) clearTimeout(retryTimerRef.current);
      window.removeEventListener('dashboard:refresh-panels', handleRefresh as EventListener);
    };
  }, [fetchData, restoreFromCache, panel.refreshIntervalSec]);

  // Visualization

  function renderContent() {
    if (loading) {
      return (
        <div className="flex items-center justify-center py-6">
          <Spinner />
        </div>
      );
    }

    if (error) {
      return (
        <div className="px-4 py-4 text-[11px] rounded-lg mx-3 my-2 flex flex-col gap-2 bg-error/10">
          <div className="text-error">{error}</div>
          {isTransientError && (
            <button
              type="button"
              onClick={() => {
                retryCountRef.current = 0;
                setError(null);
                setIsTransientError(false);
                setLoading(true);
                void fetchData();
              }}
              className="self-start text-[11px] text-primary hover:text-primary-container underline transition-colors"
            >
              Retry
            </button>
          )}
        </div>
      );
    }

    if (effectiveQueries.length === 0) {
      return <div className="flex items-center justify-center h-full text-xs text-on-surface-variant italic">No queries configured</div>;
    }

    // Check for per-query errors in batch results
    const queryErrors = multiRangeData.filter((r) => r.error).map((r) => `${r.refIds}: ${r.error}`);
    if (queryErrors.length > 0 && multiRangeData.every((r) => r.series.length === 0)) {
      return (
        <div className="text-red-400 text-xs p-3 space-y-1">
          {queryErrors.map((msg, i) => (
            <div key={i}>Query error: {msg}</div>
          ))}
        </div>
      );
    }

    switch (panel.visualization) {
      case 'time_series':
        return <div className="h-full"><TimeSeriesChart result={multiRangeData[0]} stackMode={panel.stackMode === 'normal' ? 'normal' : 'none'} unit={panel.unit} /></div>;
      case 'stat': {
        const val = firstInstantValue(instantData);
        return <StatVisualization value={val} unit={panel.unit} description={panel.description} />;
      }
      case 'gauge': {
        const val = firstInstantValue(instantData);
        return (
          <div className="flex justify-center py-1">
            <GaugeVisualization value={val} unit={panel.unit} />
          </div>
        );
      }
      case 'bar': {
        const items = instantToBarItems(instantData);
        return <div className="px-3 pb-2"><BarVisualization items={items} /></div>;
      }
      case 'table': {
        const tsData = isRangeViz ? multiRangeData[0] : transformInstantData(instantData!, activeQuery);
        return <div className="h-full"><TimeSeriesChart result={tsData} unit={panel.unit} /></div>;
      }
      case 'pie': {
        const items = instantToPieItems(instantData);
        return <div className="px-3 pb-2"><PieVisualization items={items} /></div>;
      }
      case 'histogram': {
        const buckets = instantToHistogramBuckets(instantData);
        return <div className="px-3 pb-2"><HistogramVisualization buckets={buckets} /></div>;
      }
      case 'heatmap': {
        const points = rangeToHeatmapPoints(multiRangeData);
        return <div className="px-3 pb-2"><HeatmapVisualization points={points} /></div>;
      }
      case 'status_timeline': {
        const spans = rangeToStatusSpans(multiRangeData);
        return <div className="py-3 pb-2"><StatusTimelineVisualization spans={spans} /></div>;
      }
      default:
        return (
          <div className="flex items-center justify-center h-full text-xs text-on-surface-variant italic">
            {panel.visualization} visualization not yet supported
          </div>
        );
    }
  }

  const datasourceIds = Array.from(new Set(effectiveQueries.map((q) => q.datasourceId).filter(Boolean)));

  const isStat = panel.visualization === 'stat' || panel.visualization === 'gauge';

  // Compact stat/gauge layout — like Grafana stat panel
  if (isStat) {
    return (
      <div
        className={`bg-surface-high rounded-xl h-full px-4 py-3 relative group transition-all duration-200 panel-drag-handle cursor-grab active:cursor-grabbing flex flex-col ${
          editMode ? 'ring-1 ring-dashed ring-outline-variant' : ''
        }`}
      >
        <div className="flex items-start justify-between">
          <span className="text-xs text-on-surface-variant font-medium truncate">{panel.title}</span>
          <div className={`flex items-center gap-0.5 shrink-0 ml-2 transition-opacity duration-150 ${editMode ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'}`}>
            {onEdit && <button type="button" onClick={onEdit} className="p-0.5 rounded hover:bg-surface-highest text-on-surface-variant hover:text-on-surface" title="Edit"><svg className="w-3 h-3" viewBox="0 0 20 20" fill="currentColor"><path d="M13.586 3.586a2 2 0 112.828 2.828l-8.5 8.5L5 15l.086-2.914 8.5-8.5zM4 16h12v1H4z" /></svg></button>}
            {onDelete && <button type="button" onClick={onDelete} className="p-0.5 rounded hover:bg-error/10 text-on-surface-variant hover:text-error" title="Delete"><svg className="w-3 h-3" viewBox="0 0 20 20" fill="currentColor"><path fillRule="evenodd" d="M9 2a1 1 0 00-1 1v1H5a1 1 0 100 2h.293l.853 9.386A2 2 0 008.138 17h3.724a2 2 0 001.992-1.614L14.707 6H15a1 1 0 100-2h-3V3a1 1 0 00-1-1H9zM9 4h2V3H9v1z" clipRule="evenodd" /></svg></button>}
          </div>
        </div>
        <div className="flex-1 flex items-center">{renderContent()}</div>
      </div>
    );
  }

  // Standard panel layout (time_series, bar, pie, etc.)
  return (
    <div
      className={`bg-surface-high rounded-xl h-full flex flex-col relative group transition-all duration-200 ${
        editMode ? 'ring-1 ring-dashed ring-outline-variant' : ''
      }`}
    >
      <div className="panel-drag-handle flex items-center justify-between px-4 pt-3 pb-1.5 cursor-grab active:cursor-grabbing">
        <div className="flex items-center gap-3 min-w-0">
          <div className="drag-handle w-2 h-4 bg-primary rounded-full shrink-0" />
          {loading && <Spinner />}
          <span className="text-sm font-bold text-on-surface font-[Manrope] truncate">{panel.title}</span>
        </div>

        <div className={`flex items-center gap-1 shrink-0 transition-opacity duration-150 ${editMode ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'}`}>
            {onEdit && (
              <button type="button" onClick={onEdit} className="p-1 rounded hover:bg-surface-highest text-on-surface-variant hover:text-on-surface transition-colors" title="Edit panel">
                <svg className="w-3.5 h-3.5" viewBox="0 0 20 20" fill="currentColor"><path d="M13.586 3.586a2 2 0 112.828 2.828l-8.5 8.5L5 15l.086-2.914 8.5-8.5zM4 16h12v1H4z" /></svg>
              </button>
            )}
            {onDelete && (
              <button type="button" onClick={onDelete} className="p-1 rounded hover:bg-error/10 text-on-surface-variant hover:text-error transition-colors" title="Delete panel">
                <svg className="w-3.5 h-3.5" viewBox="0 0 20 20" fill="currentColor"><path fillRule="evenodd" d="M9 2a1 1 0 00-1 1v1H5a1 1 0 100 2h.293l.853 9.386A2 2 0 008.138 17h3.724a2 2 0 001.992-1.614L14.707 6H15a1 1 0 100-2h-3V3a1 1 0 00-1-1H9zM9 4h2V3H9v1z" clipRule="evenodd" /></svg>
              </button>
            )}
          </div>
      </div>

      {panel.description && (
        <p className="px-4 text-[10px] text-on-surface-variant line-clamp-1">{panel.description}</p>
      )}

      <div className="flex-1 min-h-0 overflow-hidden">{renderContent()}</div>

      {editMode && <QueryBadge queries={effectiveQueries} />}
    </div>
  );
}
