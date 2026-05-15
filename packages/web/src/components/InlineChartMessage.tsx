/**
 * InlineChartMessage — the chat bubble that renders a time-series chart when
 * the agent calls `metric_explore` (SSE event `inline_chart`). Re-queries the
 * REST endpoint /api/metrics/query for in-chart pivots (time-range, query
 * edit, drag-to-zoom). Persisted bubbles render from their stored series; the
 * user can hit a Last-X chip to refresh.
 *
 * Built on TimeSeriesViz (uPlot) — its native `onZoom` callback drives
 * drag-to-zoom; no custom mouse-overlay is needed.
 */
import React, { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import type { ChartMetricKind, ChartSummary } from '@agentic-obs/common';
import { apiClient } from '../api/client.js';
import TimeSeriesViz, { type SeriesInput } from './viz/TimeSeriesViz.js';
import type {
  InlineChartSeries,
  InlineChartPivotSuggestion,
} from '../hooks/useDashboardChat.js';

interface Props {
  id: string;
  initialQuery: string;
  initialTimeRange: { start: string; end: string };
  initialSeries: InlineChartSeries[];
  initialSummary: ChartSummary;
  metricKind: ChartMetricKind;
  datasourceId: string;
  pivotSuggestions?: InlineChartPivotSuggestion[];
  /** Optional callback when a pivot chip is clicked — caller sends this as a new chat message. */
  onSendMessage?: (prompt: string) => void;
  /** Optional stub — opens the save-as-dashboard flow (PR-C). */
  onSaveAsDashboard?: () => void;
}

interface QueryResponse {
  series: InlineChartSeries[];
  query: string;
  timeRange: { start: string; end: string };
  summary: ChartSummary;
}

// Quick-range presets exposed by the [Last X ▾] dropdown.
const PRESETS: Array<{ label: string; relative: string }> = [
  { label: 'Last 15m', relative: '15m' },
  { label: 'Last 1h', relative: '1h' },
  { label: 'Last 6h', relative: '6h' },
  { label: 'Last 24h', relative: '24h' },
  { label: 'Last 7d', relative: '7d' },
];

// Backend accepts only 1h/6h/24h/7d as `{relative}`. Map 15m to explicit start/end.
const RELATIVE_MS: Record<string, number> = {
  '15m': 15 * 60 * 1000,
  '1h': 60 * 60 * 1000,
  '6h': 6 * 60 * 60 * 1000,
  '24h': 24 * 60 * 60 * 1000,
  '7d': 7 * 24 * 60 * 60 * 1000,
};

/**
 * Convert backend series ({ metric, values: [[unixSec, "str"]] }) to
 * TimeSeriesViz `SeriesInput` ({ labels, points: [{ ts: ms, value: num }] }).
 */
export function seriesToViz(series: InlineChartSeries[]): SeriesInput[] {
  return series.map((s) => ({
    labels: s.metric,
    points: s.values
      .map(([ts, raw]) => ({ ts: ts * 1000, value: Number.parseFloat(raw) }))
      .filter((p) => Number.isFinite(p.value)),
  }));
}

/**
 * Format the timeRange for the header bar. "last 1h" for whole-hour spans;
 * "14:00-15:30" for short ranges; falls back to ISO date for multi-day.
 */
export function formatRangeLabel(start: string, end: string): string {
  const s = new Date(start).getTime();
  const e = new Date(end).getTime();
  if (!Number.isFinite(s) || !Number.isFinite(e) || e <= s) return '';
  const spanMs = e - s;
  // Known relative spans → friendly label.
  for (const [rel, ms] of Object.entries(RELATIVE_MS)) {
    if (Math.abs(spanMs - ms) < 60_000) return `last ${rel}`;
  }
  const hh = (d: Date) =>
    `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  // Short range — clock times.
  if (spanMs < 24 * 60 * 60 * 1000) return `${hh(new Date(s))}-${hh(new Date(e))}`;
  // Multi-day — date range.
  const mmdd = (d: Date) =>
    `${d.getMonth() + 1}/${d.getDate()}`;
  return `${mmdd(new Date(s))}-${mmdd(new Date(e))}`;
}

/**
 * Best-effort title. Tries to lift a `__name__` from the series labels; falls
 * back to the first 60 chars of the query.
 */
export function deriveTitle(
  query: string,
  series: InlineChartSeries[],
  kind: ChartMetricKind,
): string {
  const first = series[0]?.metric?.__name__;
  const kindWord =
    kind === 'latency' ? 'latency' :
    kind === 'counter' ? 'rate' :
    kind === 'errors' ? 'errors' :
    'metric';
  if (first) return `${kindWord}: ${first}`;
  const trimmed = query.length > 60 ? `${query.slice(0, 60)}…` : query;
  return trimmed;
}

export default function InlineChartMessage(props: Props): JSX.Element {
  const {
    id: _id,
    initialQuery,
    initialTimeRange,
    initialSeries,
    initialSummary,
    metricKind,
    datasourceId,
    pivotSuggestions = [],
    onSendMessage,
    onSaveAsDashboard,
  } = props;

  const [query, setQuery] = useState(initialQuery);
  const [draftQuery, setDraftQuery] = useState(initialQuery);
  const [timeRange, setTimeRange] = useState(initialTimeRange);
  const [series, setSeries] = useState(initialSeries);
  const [summary, setSummary] = useState(initialSummary);
  const [loading, setLoading] = useState(false);
  const [showLoading, setShowLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [errorCode, setErrorCode] = useState<string | null>(null);
  const [queryEditorExpanded, setQueryEditorExpanded] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [rangeMenuOpen, setRangeMenuOpen] = useState(false);
  const [zoomed, setZoomed] = useState(false);

  // Sync props → state when SSE updates push a new payload with the same id.
  // The parent calls upsertInlineChart which replaces the event; React
  // rerenders this component with new initial* props. We mirror those into
  // local state so the chart picks up backend pivots without remounting.
  useEffect(() => { setQuery(initialQuery); setDraftQuery(initialQuery); }, [initialQuery]);
  useEffect(() => { setTimeRange(initialTimeRange); }, [initialTimeRange.start, initialTimeRange.end]);
  useEffect(() => { setSeries(initialSeries); }, [initialSeries]);
  useEffect(() => { setSummary(initialSummary); }, [initialSummary]);

  // 200ms-delayed loading skeleton: avoids flash for fast queries.
  useEffect(() => {
    if (!loading) {
      setShowLoading(false);
      return;
    }
    const t = setTimeout(() => setShowLoading(true), 200);
    return () => clearTimeout(t);
  }, [loading]);

  // Close menus on outside click.
  const rootRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!menuOpen && !rangeMenuOpen) return;
    const onClick = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
        setRangeMenuOpen(false);
      }
    };
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, [menuOpen, rangeMenuOpen]);

  const runQuery = useCallback(
    async (opts: {
      query?: string;
      timeRange?: { start: string; end: string };
      relative?: string;
      zoomed?: boolean;
    }) => {
      const nextQuery = opts.query ?? query;
      const body: Record<string, unknown> = {
        query: nextQuery,
        datasourceId,
        metricKind,
      };
      if (opts.relative === '15m') {
        // Backend doesn't accept 15m as `relative`; expand to explicit range.
        const end = new Date();
        const start = new Date(end.getTime() - RELATIVE_MS['15m']!);
        body['timeRange'] = { start: start.toISOString(), end: end.toISOString() };
      } else if (opts.relative) {
        body['timeRange'] = { relative: opts.relative };
      } else if (opts.timeRange) {
        body['timeRange'] = opts.timeRange;
      } else {
        body['timeRange'] = timeRange;
      }

      setLoading(true);
      setError(null);
      setErrorCode(null);
      try {
        const { data, error: apiErr } = await apiClient.post<QueryResponse>(
          '/metrics/query',
          body,
        );
        if (apiErr) {
          setError(apiErr.message);
          setErrorCode(apiErr.code ?? null);
          if (apiErr.code === 'BAD_QUERY') setQueryEditorExpanded(true);
          return;
        }
        if (!data) {
          setError('Empty response from /api/metrics/query');
          return;
        }
        setQuery(data.query);
        setDraftQuery(data.query);
        setTimeRange(data.timeRange);
        setSeries(data.series);
        setSummary(data.summary);
        setZoomed(opts.zoomed ?? false);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setLoading(false);
      }
    },
    [query, datasourceId, metricKind, timeRange],
  );

  const handleZoom = useCallback(
    (fromMs: number, toMs: number) => {
      if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || toMs <= fromMs) return;
      void runQuery({
        timeRange: {
          start: new Date(fromMs).toISOString(),
          end: new Date(toMs).toISOString(),
        },
        zoomed: true,
      });
    },
    [runQuery],
  );

  const handleResetZoom = useCallback(() => {
    void runQuery({
      timeRange: initialTimeRange,
      zoomed: false,
    });
  }, [runQuery, initialTimeRange]);

  const vizSeries = useMemo(() => seriesToViz(series), [series]);
  const hasData = vizSeries.some((s) => s.points.length > 0);
  const title = useMemo(
    () => deriveTitle(query, series, metricKind),
    [query, series, metricKind],
  );
  const rangeLabel = useMemo(
    () => formatRangeLabel(timeRange.start, timeRange.end),
    [timeRange.start, timeRange.end],
  );

  const onPivotClick = (p: InlineChartPivotSuggestion) => {
    onSendMessage?.(p.label);
  };

  const onRunEditor = () => {
    const q = draftQuery.trim();
    if (!q) return;
    void runQuery({ query: q });
  };

  return (
    <div
      ref={rootRef}
      className="my-2 rounded-md border border-outline-variant bg-surface-container overflow-hidden"
      data-testid="inline-chart-message"
    >
      {/* Header bar */}
      <div className="flex items-center gap-2 px-3 py-2 border-b border-outline-variant text-sm">
        <ChartIcon />
        <div className="font-medium text-on-surface truncate flex-1" title={query}>
          {title}
          {rangeLabel && (
            <span className="text-on-surface-variant font-normal"> · {rangeLabel}</span>
          )}
        </div>
        <div className="relative">
          <button
            type="button"
            aria-label="Chart menu"
            className="px-1.5 py-0.5 text-on-surface-variant hover:text-on-surface"
            onClick={() => setMenuOpen((v) => !v)}
          >
            ⋯
          </button>
          {menuOpen && (
            <div className="absolute right-0 top-full mt-1 z-10 min-w-[180px] rounded-md border border-outline-variant bg-surface shadow-md text-sm">
              <MenuItem
                onClick={() => {
                  setMenuOpen(false);
                  try { void navigator.clipboard?.writeText(query); } catch { /* clipboard unavailable */ }
                }}
              >
                Copy query
              </MenuItem>
              <MenuItem
                disabled={!onSaveAsDashboard}
                onClick={() => {
                  setMenuOpen(false);
                  onSaveAsDashboard?.();
                }}
              >
                Save as dashboard
              </MenuItem>
              <MenuItem disabled>Open in Explore</MenuItem>
            </div>
          )}
        </div>
      </div>

      {/* Error banner */}
      {error && (
        <div className="px-3 py-1.5 bg-error/10 text-error text-xs border-b border-error/30">
          {errorCode === 'BAD_QUERY' ? 'Invalid query: ' : ''}
          {error}
        </div>
      )}

      {/* Chart area */}
      <div className="relative">
        {showLoading && (
          <div
            data-testid="chart-loading"
            className="absolute inset-0 z-10 flex items-center justify-center bg-surface-container/80 text-xs text-on-surface-variant"
          >
            <span className="px-2 py-0.5 rounded bg-surface border border-outline-variant">
              Loading…
            </span>
          </div>
        )}
        {hasData ? (
          <>
            <TimeSeriesViz
              series={vizSeries}
              height={180}
              legend="hidden"
              onZoom={handleZoom}
            />
            {zoomed && (
              <button
                type="button"
                aria-label="Reset zoom"
                onClick={handleResetZoom}
                className="absolute top-1 right-1 px-1.5 py-0.5 text-xs bg-surface/80 border border-outline-variant rounded text-on-surface hover:bg-surface"
              >
                ↺ Reset
              </button>
            )}
          </>
        ) : loading ? (
          <div className="h-[180px] flex items-center justify-center text-xs text-on-surface-variant">
            Loading…
          </div>
        ) : (
          <div className="h-[180px] flex flex-col items-center justify-center gap-2 text-sm text-on-surface-variant">
            <div>No data in this time range</div>
            <div className="flex gap-2">
              <Chip onClick={() => void runQuery({ relative: '6h' })}>Try 6h</Chip>
              <Chip onClick={() => void runQuery({ relative: '24h' })}>Try 24h</Chip>
            </div>
          </div>
        )}
      </div>

      {/* Summary line */}
      <div className="px-3 py-1.5 border-t border-outline-variant font-mono text-xs text-on-surface">
        {summary.oneLine || (hasData ? '' : ' ')}
      </div>

      {/* Action chips */}
      <div className="flex items-center gap-2 px-3 py-2 border-t border-outline-variant text-xs">
        <div className="relative">
          <button
            type="button"
            className="px-2 py-1 rounded border border-outline-variant hover:bg-surface text-on-surface"
            onClick={() => setRangeMenuOpen((v) => !v)}
            data-testid="range-button"
          >
            {rangeLabel || 'Range'} ▾
          </button>
          {rangeMenuOpen && (
            <div className="absolute left-0 top-full mt-1 z-10 min-w-[140px] rounded-md border border-outline-variant bg-surface shadow-md">
              {PRESETS.map((p) => (
                <button
                  type="button"
                  key={p.relative}
                  className="block w-full text-left px-3 py-1.5 hover:bg-surface-container text-on-surface"
                  onClick={() => {
                    setRangeMenuOpen(false);
                    void runQuery({ relative: p.relative });
                  }}
                >
                  {p.label}
                </button>
              ))}
            </div>
          )}
        </div>
        {pivotSuggestions.map((p) => (
          <Chip key={p.id} onClick={() => onPivotClick(p)}>{p.label}</Chip>
        ))}
        <div className="flex-1" />
        <button
          type="button"
          className="px-2 py-1 rounded border border-outline-variant hover:bg-surface text-on-surface"
          onClick={() => setQueryEditorExpanded((v) => !v)}
          data-testid="query-toggle"
        >
          {queryEditorExpanded ? '▲ Query' : '▼ Query'}
        </button>
      </div>

      {/* Query editor */}
      {queryEditorExpanded && (
        <div className="px-3 py-2 border-t border-outline-variant space-y-2">
          <textarea
            value={draftQuery}
            onChange={(e) => setDraftQuery(e.target.value)}
            rows={3}
            className="w-full bg-surface border border-outline-variant rounded p-2 font-mono text-xs text-on-surface"
            data-testid="query-editor"
          />
          <div className="flex items-center gap-2 text-xs">
            <span className="px-2 py-0.5 rounded bg-surface text-on-surface-variant border border-outline-variant">
              Datasource: {datasourceId}
            </span>
            <div className="flex-1" />
            <button
              type="button"
              className="px-3 py-1 rounded bg-primary text-on-primary hover:opacity-90 disabled:opacity-50"
              onClick={onRunEditor}
              disabled={!draftQuery.trim() || loading}
              data-testid="run-query"
            >
              Run
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function ChartIcon() {
  return (
    <svg
      className="w-4 h-4 text-on-surface-variant shrink-0"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      aria-hidden
    >
      <path strokeLinecap="round" strokeLinejoin="round" d="M3 3v18h18M7 14l3-3 3 3 5-6" />
    </svg>
  );
}

function MenuItem({
  children,
  onClick,
  disabled,
}: {
  children: React.ReactNode;
  onClick?: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className="block w-full text-left px-3 py-1.5 text-on-surface hover:bg-surface-container disabled:opacity-50 disabled:cursor-not-allowed"
    >
      {children}
    </button>
  );
}

function Chip({
  children,
  onClick,
}: {
  children: React.ReactNode;
  onClick?: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="px-2 py-0.5 rounded-full text-xs bg-surface border border-outline-variant hover:bg-surface-container text-on-surface"
    >
      {children}
    </button>
  );
}
