import React, { useEffect, useState, useCallback, useRef, useMemo } from 'react';
import { apiClient } from '../api/client.js';
import { queryScheduler } from '../api/query-scheduler.js';
import TimeSeriesViz from './viz/TimeSeriesViz.js';
import StatViz from './viz/StatViz.js';
import GaugeViz from './viz/GaugeViz.js';
import BarViz from './viz/BarViz.js';
import BarGaugeViz from './viz/BarGaugeViz.js';
import PieViz from './viz/PieViz.js';
import HistogramViz from './viz/HistogramViz.js';
import HeatmapViz from './viz/HeatmapViz.js';
import StatusTimelineViz from './viz/StatusTimelineViz.js';
import type { PanelQuery, PanelConfig, RangeResponse, InstantResponse, QueryResult } from './panel/types.js';
import {
  transformQueryResult,
  firstInstantValue,
  instantToBarItems,
  instantToPieItems,
  instantToHistogramBuckets,
  rangeToHeatmapPoints,
  rangeToStatusSpans,
} from './panel/query-transformers.js';
import { RangeResponseSchema, InstantResponseSchema, parseOrThrow } from '../api/schemas.js';

// Backward-compat re-exports so existing consumers don't break
export type { PanelQuery, PanelThreshold, PanelSnapshotData, PanelConfig } from './panel/types.js';

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

// Info icon — hover to reveal panel description in a native title tooltip.
// Native tooltips are good enough here: they avoid a portal/positioning system
// and don't compete with the rest of the panel chrome on hover.
function InfoIcon({ description }: { description: string }) {
  return (
    <span
      title={description}
      aria-label={description}
      className="inline-flex shrink-0 items-center justify-center rounded-full text-on-surface-variant/60 hover:text-on-surface-variant cursor-help"
    >
      <svg className="w-3 h-3" viewBox="0 0 16 16" fill="currentColor" aria-hidden>
        <path d="M8 1.5a6.5 6.5 0 100 13 6.5 6.5 0 000-13zM8 13A5 5 0 118 3a5 5 0 010 10zm-.75-7.5a.75.75 0 111.5 0 .75.75 0 01-1.5 0zM7 7h2v4.5H7V7z" />
      </svg>
    </span>
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
    const startDate = new Date(parts[0] ?? '');
    const endDate = new Date(parts[1] ?? '');
    if (!Number.isNaN(startDate.getTime()) && !Number.isNaN(endDate.getTime())) {
      return { start: startDate.toISOString(), end: endDate.toISOString() };
    }
  }
  return { start: new Date(end.getTime() - ms).toISOString(), end: end.toISOString() };
}

interface Props {
  panel: PanelConfig;
  onEdit?: () => void;
  onDelete?: () => void;
  editMode?: boolean;
  timeRange?: string;
  /** Fired when the user box-zooms on a time-series panel; value is a
   *  resolveTimeRange-compatible `"ISO|ISO"` absolute range string. */
  onTimeRangeChange?: (range: string) => void;
}

export default function DashboardPanelCard({
  panel,
  onEdit,
  onDelete,
  editMode = false,
  timeRange = '1h',
  onTimeRangeChange,
}: Props) {
  const [loading, setLoading] = useState(true);
  const [multiRangeData, setMultiRangeData] = useState<QueryResult[]>([]);
  const [instantData, setInstantData] = useState<InstantResponse | null>(null);
  const [sparklineData, setSparklineData] = useState<{ timestamps: number[]; values: number[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isTransientError, setIsTransientError] = useState(false);
  /** Set when a transient refresh failed but we already have data on screen.
   *  We keep showing the stale data (good UX) but flag it visually so users
   *  know what they see is no longer fresh. Cleared on next successful fetch. */
  const [staleSinceMs, setStaleSinceMs] = useState<number | null>(null);
  /** Forces re-render of the "Xs ago" label so the indicator's age updates. */
  const [, setStaleNowTick] = useState(0);

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
  // Stat panels fetch a sparkline trend by default (in parallel with the
  // instant query). Agent can opt out with `sparkline: false` for genuinely
  // time-invariant metrics (config counts, version strings) — but for the
  // 95% case where you do want a trend, omitting the field is enough.
  const wantsSparkline = panel.visualization === 'stat' && panel.sparkline !== false;
  const activePanelQuery = effectiveQueries[0];
  const activeQuery = activePanelQuery?.expr ?? '';
  const resolvedTimeRange = useMemo(() => resolveTimeRange(timeRange), [timeRange]);

  // Build a stable dedup key from queries
  const queryKey = useMemo(
    () => effectiveQueries.map((q) => `${q.datasourceId ?? 'default'}:${q.expr}`).join('|') + `@${timeRange}`,
    [effectiveQueries, timeRange]
  );
  const instantQueryKey = useMemo(
    () => `${activePanelQuery?.datasourceId ?? 'default'}:${activeQuery}@${resolvedTimeRange.end}`,
    [activePanelQuery?.datasourceId, activeQuery, resolvedTimeRange.end]
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
        // If we already have data, keep showing it (stale data > blank panel)
        // but surface a visible "stale" indicator so the user knows the
        // refresh failed. Log so the underlying transient is debuggable.
        if (transient && hasExistingData) {
          console.warn(`[panel ${panel.id}] transient refresh failure, showing stale data:`, msg);
          retryCountRef.current = 0;
          setStaleSinceMs((prev) => prev ?? Date.now());
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
                queries: effectiveQueries.map((q) => ({
                  refId: q.refId,
                  expr: q.expr,
                  instant: q.instant,
                  datasourceId: q.datasourceId,
                })),
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
            // Boundary validation — fail loudly if the server drifts off the
            // RangeResponse shape rather than feeding malformed data into the
            // viz transform path.
            const validated = parseOrThrow(RangeResponseSchema, 'RangeResponse', rr.data);
            return transformQueryResult(validated, pq);
          });
          setMultiRangeData(results);
          setStaleSinceMs(null);
        } catch (err) {
          handleError(err instanceof Error ? err.message : 'Query failed');
          return;
        }
      } else {
        try {
          // Stat-with-sparkline runs both fetches in parallel; the instant
          // value drives the big number, the range query feeds the trend.
          const sparklinePromise: Promise<void> = wantsSparkline
            ? queryScheduler
                .schedule<{ data: RangeResponse | null; error?: unknown }>(
                  `spark:${queryKey}`,
                  () =>
                    apiClient.post('/query/range', {
                      query: activeQuery,
                      datasourceId: activePanelQuery?.datasourceId,
                      ...resolveTimeRange(timeRange),
                    }) as Promise<{ data: RangeResponse | null; error?: unknown }>,
                )
                .then((sparkRes) => {
                  if (sparkRes.error || !sparkRes.data) return;
                  // Boundary validation; throws ApiResponseShapeError on drift.
                  const validated = parseOrThrow(RangeResponseSchema, 'RangeResponse', sparkRes.data);
                  // Use only the first series — sparkline is a single trend.
                  const first = validated.data.result[0];
                  if (!first || !first.values) return;
                  const timestamps: number[] = [];
                  const values: number[] = [];
                  for (const [ts, v] of first.values) {
                    const num = Number.parseFloat(v);
                    if (Number.isFinite(num)) {
                      timestamps.push(ts * 1000);
                      values.push(num);
                    }
                  }
                  setSparklineData({ timestamps, values });
                })
                .catch((err) => {
                  // Sparkline failure is non-fatal — keep the panel showing
                  // the value without trend rather than erroring out — but
                  // log so a permanently-broken sparkline is visible in the
                  // console instead of silently absent.
                  console.warn(`[panel ${panel.id}] sparkline query failed`, err);
                })
            : Promise.resolve();

          const res = await queryScheduler.schedule<{ data: InstantResponse | null; error?: unknown }>(
            `instant:${instantQueryKey}`,
            () =>
              apiClient.post('/query/instant', {
                query: activeQuery,
                time: resolvedTimeRange.end,
                datasourceId: activePanelQuery?.datasourceId,
              }) as Promise<{
                data: InstantResponse | null;
                error?: unknown;
              }>
          );
          if (res.error) {
            handleError(extractErrorMessage(res.error));
            return;
          }
          retryCountRef.current = 0;
          if (res.data) {
            const validated = parseOrThrow(InstantResponseSchema, 'InstantResponse', res.data);
            setInstantData(validated);
          } else {
            setInstantData(null);
          }
          setStaleSinceMs(null);
          await sparklinePromise;
        } catch (err) {
          handleError(err instanceof Error ? err.message : 'Query failed');
          return;
        }
      }

      setLoading(false);
    },
    [effectiveQueries, isRangeViz, activePanelQuery?.datasourceId, activeQuery, instantQueryKey, queryKey, cacheMaxAgeMs, multiRangeData.length, instantData, panel.refreshIntervalSec, panel.id, resolvedTimeRange.end, timeRange]
  );

  // Try to restore from cache without fetching
  const restoreFromCache = useCallback(() => {
    const cacheKey = isRangeViz ? `batch:${queryKey}` : `instant:${instantQueryKey}`;
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

      // Stat panels also need their sparkline trend from cache, otherwise a
      // page refresh restores the big number but drops the line underneath.
      // If the sparkline query wasn't cached (or is stale) we fall through
      // to the full fetch path below — a half-restored panel is worse than
      // a one-shot refetch.
      if (wantsSparkline) {
        const sparkCached = queryScheduler.getCached<{ data: RangeResponse | null }>(
          `spark:${queryKey}`,
          cacheMaxAgeMs,
        );
        const first = sparkCached?.data?.data?.result?.[0];
        if (!first?.values) return false;
        const timestamps: number[] = [];
        const values: number[] = [];
        for (const [ts, v] of first.values) {
          const num = Number.parseFloat(v);
          if (Number.isFinite(num)) {
            timestamps.push(ts * 1000);
            values.push(num);
          }
        }
        setSparklineData({ timestamps, values });
      }
    }

    setLoading(false);
    return true;
  }, [isRangeViz, queryKey, instantQueryKey, cacheMaxAgeMs, effectiveQueries, wantsSparkline]);

  // Snapshot mode: when snapshotData is present, populate state directly
  // and skip all live fetching, caching, and refresh intervals.
  const hasSnapshot = !!panel.snapshotData;

  useEffect(() => {
    if (hasSnapshot) {
      const snap = panel.snapshotData!;
      if (snap.range) {
        setMultiRangeData(snap.range.map((r) => ({
          refIds: r.refId,
          legendFormat: r.legendFormat,
          series: r.series,
          totalSeries: r.totalSeries,
        })));
      }
      if (snap.instant) {
        setInstantData(snap.instant as InstantResponse);
      }
      if (snap.sparkline) {
        setSparklineData(snap.sparkline);
      }
      setLoading(false);
      return;
    }

    setError(null);
    setIsTransientError(false);
    setStaleSinceMs(null);
    setMultiRangeData([]);
    setInstantData(null);
    setSparklineData(null);
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
  }, [fetchData, restoreFromCache, panel.refreshIntervalSec, hasSnapshot, panel.snapshotData]);

  // While the panel is showing stale data after a transient refresh failure,
  // tick once a second so the "Xs ago" indicator stays accurate without us
  // having to recompute on every render unconditionally.
  useEffect(() => {
    if (staleSinceMs === null) return undefined;
    const t = setInterval(() => setStaleNowTick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [staleSinceMs]);

  /** Render the small overlay that appears on the panel when the most recent
   *  refresh failed but we're still showing the previously-fetched values. */
  function StaleIndicator() {
    if (staleSinceMs === null) return null;
    const ageSec = Math.max(0, Math.floor((Date.now() - staleSinceMs) / 1000));
    const label =
      ageSec < 60
        ? `${ageSec}s ago`
        : ageSec < 3600
          ? `${Math.floor(ageSec / 60)}m ago`
          : `${Math.floor(ageSec / 3600)}h ago`;
    return (
      <div
        className="absolute top-2 right-2 z-10 flex items-center gap-1 rounded-md bg-chart-yellow/15 text-chart-yellow px-1.5 py-0.5 text-[10px] font-medium pointer-events-auto"
        title="The most recent refresh failed; this panel is showing the last successful response."
      >
        <span className="w-1.5 h-1.5 rounded-full bg-chart-yellow" />
        stale (last refreshed {label})
      </div>
    );
  }

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
        <div className="text-error text-xs p-3 space-y-1">
          {queryErrors.map((msg, i) => (
            <div key={i}>Query error: {msg}</div>
          ))}
        </div>
      );
    }

    const flattenedSeries = multiRangeData.flatMap((r) =>
      r.series.map((s) => ({ ...s, refId: r.refIds, legendFormat: r.legendFormat })),
    );
    const stacking: 'none' | 'normal' | 'percent' =
      panel.stackMode === 'normal' ? 'normal' : panel.stackMode === 'percent' ? 'percent' : 'none';

    switch (panel.visualization) {
      case 'time_series':
        return (
          <div className="h-full">
            <TimeSeriesViz
              series={flattenedSeries}
              stacking={stacking}
              unit={panel.unit}
              thresholds={panel.thresholds}
              lineWidth={panel.lineWidth}
              fillOpacity={panel.fillOpacity}
              showPoints={panel.showPoints}
              yScale={panel.yScale}
              legendStats={panel.legendStats}
              legendPlacement={panel.legendPlacement}
              annotations={panel.annotations}
              onZoom={
                onTimeRangeChange
                  ? (from, to) => {
                      onTimeRangeChange(
                        `${new Date(from).toISOString()}|${new Date(to).toISOString()}`,
                      );
                    }
                  : undefined
              }
            />
          </div>
        );
      case 'stat': {
        const val = firstInstantValue(instantData);
        return (
          <StatViz
            value={val}
            unit={panel.unit}
            decimals={panel.decimals}
            thresholds={panel.thresholds}
            colorMode={panel.colorMode ?? 'value'}
            sparkline={sparklineData ?? undefined}
          />
        );
      }
      case 'gauge': {
        const rawVal = firstInstantValue(instantData);
        // percentunit (0-1) is rendered as 0-100% via the 'percent' formatter;
        // percent (already 0-100) keeps its formatter. Other units pass through.
        let val = rawVal;
        let max = 100;
        let displayUnit = panel.unit;
        if (panel.unit === 'percentunit' && typeof rawVal === 'number') {
          val = rawVal * 100;
          displayUnit = 'percent';
        }
        return (
          <div className="flex h-full w-full items-center justify-center">
            <GaugeViz
              value={val}
              max={max}
              unit={displayUnit}
              thresholds={panel.thresholds}
            />
          </div>
        );
      }
      case 'bar': {
        const items = instantToBarItems(instantData);
        return (
          <div className="h-full px-3 pb-2">
            <BarViz items={items} unit={panel.unit} thresholds={panel.thresholds} />
          </div>
        );
      }
      case 'bar_gauge': {
        const items = instantToBarItems(instantData);
        // percentunit (0-1) → percent (0-100) so the formatter and the
        // implicit ceiling line up with the user's mental model.
        let displayItems = items;
        let displayMax = panel.barGaugeMax;
        let displayUnit = panel.unit;
        if (panel.unit === 'percentunit') {
          displayItems = items.map((it) => ({ ...it, value: it.value * 100 }));
          displayUnit = 'percent';
          if (displayMax === undefined) displayMax = 100;
        } else if (panel.unit === 'percent' && displayMax === undefined) {
          displayMax = 100;
        }
        return (
          <div className="h-full px-3 pb-2">
            <BarGaugeViz
              items={displayItems}
              unit={displayUnit}
              thresholds={panel.thresholds}
              mode={panel.barGaugeMode ?? 'gradient'}
              {...(displayMax !== undefined ? { max: displayMax } : {})}
            />
          </div>
        );
      }
      case 'table': {
        // Table routing currently reuses the time-series viz for range data.
        // A DataFrame-backed TableViz exists but wiring requires converting
        // instantData → DataFrame; kept for a follow-up task.
        return (
          <div className="h-full">
            <TimeSeriesViz
              series={flattenedSeries}
              stacking={stacking}
              unit={panel.unit}
              thresholds={panel.thresholds}
            />
          </div>
        );
      }
      case 'pie': {
        const items = instantToPieItems(instantData);
        return (
          <div className="h-full px-3 pb-2">
            <PieViz items={items} unit={panel.unit} />
          </div>
        );
      }
      case 'histogram': {
        const buckets = instantToHistogramBuckets(instantData);
        return (
          <div className="h-full px-3 pb-2">
            <HistogramViz buckets={buckets} unit={panel.unit} />
          </div>
        );
      }
      case 'heatmap': {
        const points = rangeToHeatmapPoints(multiRangeData);
        return (
          <div className="h-full px-3 pb-2">
            <HeatmapViz
              points={points}
              unit={panel.unit}
              colorScale={panel.colorScale ?? 'sqrt'}
              collapseEmptyBuckets={panel.collapseEmptyBuckets ?? true}
            />
          </div>
        );
      }
      case 'status_timeline': {
        const spans = rangeToStatusSpans(multiRangeData);
        return (
          <div className="py-3 pb-2">
            <StatusTimelineViz spans={spans} />
          </div>
        );
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
        className={`bg-surface-container border border-outline-variant rounded-xl h-full px-3 py-2 relative group transition-all duration-200 panel-drag-handle cursor-grab active:cursor-grabbing flex flex-col hover:border-outline ${
          editMode ? 'ring-1 ring-dashed ring-outline-variant' : ''
        }`}
      >
        <StaleIndicator />
        <div className="flex items-start justify-between gap-2">
          <div className="flex items-center gap-2 min-w-0">
            <div className="w-2 h-4 bg-primary rounded-full shrink-0" />
            <span className="text-sm font-bold text-on-surface font-[Manrope] truncate">{panel.title}</span>
            {panel.description && <InfoIcon description={panel.description} />}
          </div>
          <div className={`flex items-center gap-0.5 shrink-0 transition-opacity duration-150 ${editMode ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'}`}>
            {onEdit && <button type="button" onClick={onEdit} className="p-0.5 rounded hover:bg-surface-highest text-on-surface-variant hover:text-on-surface" title="Edit"><svg className="w-3 h-3" viewBox="0 0 20 20" fill="currentColor"><path d="M13.586 3.586a2 2 0 112.828 2.828l-8.5 8.5L5 15l.086-2.914 8.5-8.5zM4 16h12v1H4z" /></svg></button>}
            {onDelete && <button type="button" onClick={onDelete} className="p-0.5 rounded hover:bg-error/10 text-on-surface-variant hover:text-error" title="Delete"><svg className="w-3 h-3" viewBox="0 0 20 20" fill="currentColor"><path fillRule="evenodd" d="M9 2a1 1 0 00-1 1v1H5a1 1 0 100 2h.293l.853 9.386A2 2 0 008.138 17h3.724a2 2 0 001.992-1.614L14.707 6H15a1 1 0 100-2h-3V3a1 1 0 00-1-1H9zM9 4h2V3H9v1z" clipRule="evenodd" /></svg></button>}
          </div>
        </div>
        <div className="flex-1 flex items-center justify-center min-h-0">{renderContent()}</div>
      </div>
    );
  }

  // Standard panel layout (time_series, bar, pie, etc.)
  return (
    <div
      className={`bg-surface-container border border-outline-variant rounded-xl h-full flex flex-col relative group transition-all duration-200 hover:border-outline ${
        editMode ? 'ring-1 ring-dashed ring-outline-variant' : ''
      }`}
    >
      <StaleIndicator />
      <div className="panel-drag-handle flex items-center justify-between px-3 pt-2 pb-1 cursor-grab active:cursor-grabbing">
        <div className="flex items-center gap-2 min-w-0">
          <div className="drag-handle w-2 h-4 bg-primary rounded-full shrink-0" />
          {loading && <Spinner />}
          <span className="text-sm font-bold text-on-surface font-[Manrope] truncate">{panel.title}</span>
          {panel.description && <InfoIcon description={panel.description} />}
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

      <div className="flex-1 min-h-0 overflow-hidden">{renderContent()}</div>

      <QueryBadge queries={effectiveQueries} />
    </div>
  );
}
