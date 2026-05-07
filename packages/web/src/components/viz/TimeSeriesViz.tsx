/**
 * TimeSeriesViz — a Grafana-quality time-series panel for prism.
 *
 * Accepts the legacy `SeriesInput` shape so existing callers can swap
 * `TimeSeriesChart` for this component with a single import change. Internally
 * we translate to the `DataFrame` model, drive uPlot via `UPlotConfigBuilder`,
 * and layer React chrome on top: a custom legend (list or table), a
 * cursor-following tooltip, and a zoom-to-range hook.
 *
 * Design notes:
 * - uPlot owns the canvas + axes. React owns everything else. Anything else
 *   creates ordering/rerender bugs where the canvas redraws faster than React
 *   can keep up.
 * - The plot instance is stashed via `onReady`. `setSeries` toggles are issued
 *   imperatively against that ref; React state just tracks which series are
 *   hidden so the legend swatches fade correctly.
 * - Tooltip x-position is measured off the live `u.cursor.left` in a hook so
 *   we avoid a React render-per-pixel of mouse travel.
 */
import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from 'react';
import { flushSync } from 'react-dom';
import type uPlot from 'uplot';

import { publishCursor, subscribeCursor } from '../../lib/viz-sync/cursor-sync.js';
import type { PanelAnnotation } from '../panel/types.js';

import {
  createTimeSeriesFrame,
  getFieldDisplayName,
  type DataFrame,
  type Field,
  type Threshold,
} from '../../lib/data/index.js';
import { formatValueForDisplay } from '../../lib/format/index.js';
import {
  UPlotChart,
  UPlotConfigBuilder,
  type NullMode,
  type StackingMode,
} from '../../lib/uplot/index.js';
import { getSeriesColor, getSeriesColorByKey, VIZ_TOKENS } from '../../lib/theme/index.js';
import {
  decideLegendLayout,
  usePanelLayout,
  type LegendLayoutDecision,
  type PanelLayout,
} from '../../lib/viz/usePanelLayout.js';
import type { LegendPlacement, LegendStat } from '../panel/types.js';

// ---------------------------------------------------------------------------
// Public prop shape (mirrors the legacy TimeSeriesChart so callers can swap).
// ---------------------------------------------------------------------------

interface TimeSeriesPoint {
  ts: number;
  value: number;
}

interface TimeSeriesData {
  labels: Record<string, string>;
  points: TimeSeriesPoint[];
}

export interface SeriesInput extends TimeSeriesData {
  refId?: string;
  legendFormat?: string;
}

export interface TimeSeriesVizProps {
  series: SeriesInput[];
  unit?: string;
  thresholds?: Threshold[];
  height?: number;
  stacking?: StackingMode;
  legend?: 'hidden' | 'list' | 'table';
  nullMode?: NullMode;
  onZoom?: (from: number, to: number) => void;
  /**
   * Which stats to render inline after each legend entry, in order. Defaults
   * to `['last']` to preserve the pre-T-022 list-mode look. Table mode uses
   * this to pick which columns to show (defaults to all four if omitted).
   */
  legendStats?: LegendStat[];
  /**
   * Legend position relative to the chart. Currently only `'bottom'` is
   * implemented; `'right'` is accepted but falls back to `'bottom'` (TODO).
   */
  legendPlacement?: LegendPlacement;
  /**
   * Shared crosshair key. All TimeSeriesViz instances with the same key
   * receive each other's cursor position. Defaults to `'prism-panels'` so
   * panels on the same page automatically sync.
   */
  syncKey?: string;
  /**
   * Stroke width (CSS pixels) applied to every series. Defaults to
   * `VIZ_TOKENS.series.lineWidth` when omitted. Mirrors `PanelConfig.lineWidth`.
   */
  lineWidth?: number;
  /**
   * Area-fill alpha (0–1) under each series in the series color. `0` (default)
   * disables the fill. Mirrors `PanelConfig.fillOpacity`.
   */
  fillOpacity?: number;
  /**
   * Resting point-marker policy. `'auto'` (default) = show when each sample
   * owns >25 CSS px of horizontal space; `'never'` = always off; `'always'` =
   * always on. Mirrors `PanelConfig.showPoints` plus an `'always'` extension.
   */
  showPoints?: 'auto' | 'never' | 'always';
  /**
   * Y-axis scale. `undefined` / `'auto'` = switch to log when value range
   * spans >3 orders of magnitude. `'linear'` / `'log'` force the choice.
   */
  yScale?: 'auto' | 'linear' | 'log';
  /**
   * Vertical event markers (deploys, incidents, alert firings) drawn at
   * specific timestamps. Hovered to reveal label.
   */
  annotations?: PanelAnnotation[];
}

// ---------------------------------------------------------------------------
// Legend-format template expansion (`{{label}}` → labels.label).
// ---------------------------------------------------------------------------

function applyLegendFormat(format: string, labels: Record<string, string>): string {
  return format.replace(/\{\{\s*([^}\s]+)\s*\}\}/g, (_, key: string) => labels[key] ?? '');
}

function defaultDisplayName(input: SeriesInput, index: number): string {
  if (input.legendFormat && input.legendFormat.length > 0) {
    const expanded = applyLegendFormat(input.legendFormat, input.labels);
    if (expanded.length > 0) return expanded;
  }
  // Prometheus-style __name__{k="v", ...} or k=v,k2=v2 composition; fall back
  // to a synthesized name when labels are empty so two empty-label series are
  // still distinguishable.
  const { __name__: metric, ...rest } = input.labels;
  const parts = Object.entries(rest).map(([k, v]) => `${k}="${v}"`);
  if (metric && metric.length > 0) {
    return parts.length > 0 ? `${metric}{${parts.join(',')}}` : metric;
  }
  if (parts.length > 0) return parts.join(', ');
  // Aggregation queries (e.g. `histogram_quantile(...)`) collapse all labels.
  // Prefer the refId if the panel set one — it maps back to the PromQL row
  // the user wrote. Only fall back to the numeric index when nothing else is
  // available.
  if (input.refId && input.refId.length > 0) return input.refId;
  return `series ${index + 1}`;
}

function stableKey(labels: Record<string, string>, fallback: string): string {
  const keys = Object.keys(labels).sort();
  if (keys.length === 0) return fallback;
  return keys.map((k) => `${k}=${labels[k]}`).join(',');
}

// ---------------------------------------------------------------------------
// Series metadata captured at build time. Kept parallel to `frames` so we can
// look up colors + stats from the React side (uPlot's options tree has them
// buried behind private accessors).
// ---------------------------------------------------------------------------

interface SeriesMeta {
  displayName: string;
  color: string;
  /** Values aligned to the union x-axis (post stacking is not applied). */
  values: Array<number | null>;
  last: number | null;
  min: number | null;
  max: number | null;
  mean: number | null;
}

function computeStats(values: Array<number | null>): Pick<SeriesMeta, 'last' | 'min' | 'max' | 'mean'> {
  let last: number | null = null;
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  let sum = 0;
  let count = 0;
  for (const v of values) {
    if (typeof v !== 'number' || Number.isNaN(v)) continue;
    last = v;
    if (v < min) min = v;
    if (v > max) max = v;
    sum += v;
    count += 1;
  }
  if (count === 0) {
    return { last: null, min: null, max: null, mean: null };
  }
  return { last, min, max, mean: sum / count };
}

// ---------------------------------------------------------------------------
// Build `DataFrame[]` + `SeriesMeta[]` + `{ options, data }` from props.
// ---------------------------------------------------------------------------

interface BuildResult {
  frames: DataFrame[];
  metas: SeriesMeta[];
  xs: number[];
  options: uPlot.Options;
  data: uPlot.AlignedData;
}

function buildViz(props: TimeSeriesVizProps): BuildResult {
  const {
    series,
    unit,
    thresholds,
    height = 240,
    stacking = 'none',
    nullMode = 'gap',
    lineWidth,
    fillOpacity,
    showPoints,
    yScale,
  } = props;

  const frames: DataFrame[] = [];
  const metas: SeriesMeta[] = [];

  series.forEach((s, i) => {
    const displayName = defaultDisplayName(s, i);
    const key = stableKey(s.labels, displayName);
    const color =
      Object.keys(s.labels).length > 0 ? getSeriesColorByKey(key) : getSeriesColor(i);

    const timestamps = s.points.map((p) => p.ts);
    const values = s.points.map((p) =>
      typeof p.value === 'number' && !Number.isNaN(p.value) ? p.value : (null as unknown as number),
    );

    const frame = createTimeSeriesFrame({
      name: displayName,
      timestamps,
      values,
      labels: s.labels,
      ...(unit !== undefined ? { unit } : {}),
      color,
    });
    // Stamp the displayName on the value field so `getFieldDisplayName` and
    // the config-builder label match the legend.
    const valueField = frame.fields.find((f) => f.type === 'number') as
      | Field<number | null>
      | undefined;
    if (valueField) {
      valueField.config.displayName = displayName;
    }
    frames.push(frame);
    metas.push({
      displayName,
      color,
      values: [], // filled in after alignment below
      last: null,
      min: null,
      max: null,
      mean: null,
    });
  });

  const builder = new UPlotConfigBuilder({ height, showLegend: false })
    .addTimeSeriesFrames(frames)
    .setStacking(stacking)
    .setNullMode(nullMode);
  if (unit !== undefined) builder.setUnit(unit);
  if (thresholds !== undefined) builder.setThresholds(thresholds);
  if (lineWidth !== undefined) builder.setLineWidth(lineWidth);
  if (fillOpacity !== undefined) builder.setFillOpacity(fillOpacity);
  if (showPoints !== undefined) builder.setShowPoints(showPoints);
  if (yScale !== undefined) builder.setYScale(yScale);

  const { options, data } = builder.build();

  // `data` is [xs, ...seriesValues]. Pull the aligned series arrays back out
  // so the React side can compute last/min/max/mean against the same vectors
  // uPlot is drawing. This keeps the legend numbers honest under stacking
  // (they reflect the stacked totals, which is what the user sees).
  const rawData = data as unknown as ReadonlyArray<ReadonlyArray<number | null>>;
  const xs = (rawData[0] ?? []) as ReadonlyArray<number>;
  for (let i = 0; i < metas.length; i += 1) {
    const aligned = (rawData[i + 1] ?? []) as ReadonlyArray<number | null>;
    const values = aligned.slice();
    const meta = metas[i]!;
    meta.values = values;
    Object.assign(meta, computeStats(values));
  }

  return { frames, metas, xs: xs.slice(), options, data };
}

// ---------------------------------------------------------------------------
// Component.
// ---------------------------------------------------------------------------

const TOOLTIP_OFFSET = 12;

export function TimeSeriesViz(props: TimeSeriesVizProps): JSX.Element {
  const {
    series,
    unit,
    legend = 'list',
    onZoom,
    height = 240,
    syncKey,
    legendStats,
    annotations,
    // legendPlacement === 'right' is intentionally not implemented yet — the
    // chart layout would need to switch from column to row and re-allocate
    // width. For now we always render the legend below the chart. (T-023 TODO)
  } = props;

  // -- Empty state -----------------------------------------------------------

  const isEmpty =
    series.length === 0 ||
    series.every((s) => s.points.length === 0);

  // -- Build uPlot options/data. Memoize so `options` identity is stable and
  //    UPlotChart doesn't destroy/recreate the plot on every parent render. --

  const built = useMemo(() => (isEmpty ? null : buildViz(props)), [
    // Intentionally narrow deps: only inputs that affect the build. Avoid
    // depending on `props` identity (parents often spread fresh objects).
    series,
    unit,
    props.thresholds,
    height,
    props.stacking,
    props.nullMode,
    props.lineWidth,
    props.fillOpacity,
    props.showPoints,
    props.yScale,
    isEmpty,
  ]);

  // -- Per-series visibility. Key by displayName so toggle state survives
  //    rebuilds as long as the series set is stable. -------------------------

  const [hidden, setHidden] = useState<Record<string, boolean>>({});

  const plotRef = useRef<uPlot | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  // Stable id used to filter our own publishes from the cross-panel cursor bus.
  const sourceId = useId();
  // Tracks whether the user's pointer is physically over THIS chart. The
  // tooltip card renders only when true — the synced crosshair line still
  // appears on every panel via uPlot's sync hub, but the tooltip belongs
  // to the panel the user is actually looking at.
  const [isPointerInside, setIsPointerInside] = useState(false);
  // True whenever the uPlot crosshair should be visible on this panel —
  // either because our own pointer is inside the plot area (hasOwnCursor)
  // or because a sibling panel is publishing a synced cursor
  // (hasSyncedCursor). We cannot rely on `isPointerInside` alone: it tracks
  // the outer container (title / legend / axes all count as "inside") but
  // uPlot's own crosshair only has meaningful state while the pointer is
  // actually over the plot. And `plot.setCursor({left:-10, top:-10})` does
  // NOT remove the crosshair DOM — the lines freeze at their last position
  // until something hides them via CSS.
  const [hasOwnCursor, setHasOwnCursor] = useState(false);
  const [hasSyncedCursor, setHasSyncedCursor] = useState(false);
  // Set to true while we're applying a cursor position received from the
  // cross-panel bus. The setCursor hook checks it and skips publishing back,
  // breaking the publish→subscribe→publish loop that would otherwise make A
  // and B (or A and heatmap) ping-pong forever.
  const applyingExternalRef = useRef(false);

  // -- Cross-panel cursor sync. uPlot's built-in sync only links uPlot
  //    instances; canvas-based panels (heatmap) publish via a custom event
  //    bus, and this hook moves the uPlot crosshair when one of those fires.
  useEffect(() => {
    return subscribeCursor(syncKey ?? 'prism-panels', sourceId, (detail) => {
      const plot = plotRef.current;
      if (!plot) return;
      // Mark this setCursor as externally driven so the setCursor hook
      // doesn't re-publish to the bus and bounce the event back to senders.
      applyingExternalRef.current = true;
      try {
        if (detail.ts === null) {
          // Don't touch plot.setCursor here — calling setCursor(-10,-10)
          // synchronously repaints uPlot's crosshair divs at (0,0) before
          // React applies the `ts-no-cursor` class, producing a visible
          // flash in the top-left corner. The CSS hide alone is enough;
          // the uPlot cursor divs just stay at their last position
          // underneath, invisible.
          setHasSyncedCursor(false);
          return;
        }
        const left = plot.valToPos(detail.ts, 'x');
        if (!Number.isFinite(left) || left < 0) return;
        setHasSyncedCursor(true);
        // Map the publisher's Y-fraction onto this panel's own plot height
        // so the horizontal crosshair tracks the source's pointer instead
        // of sitting at a fixed mid-plot line. Fall back to mid when no
        // fraction was published (e.g. cursor cleared / canvas viz with
        // no pointer-inside-plot info). Clamp to ≥1 — passing top: 0 is
        // treated as "leaving the plot" on some uPlot versions and hides
        // the vertical line too.
        const over = (plot as unknown as { over?: HTMLElement }).over;
        const overH = over?.clientHeight ?? 0;
        const pct = typeof detail.topPct === 'number' ? detail.topPct : 0.5;
        const top = Math.max(1, Math.min(overH - 1, overH * pct));
        plot.setCursor({ left, top });
      } finally {
        applyingExternalRef.current = false;
      }
    });
  }, [sourceId, syncKey]);

  // -- Tooltip state. Updated synchronously from uPlot's setCursor hook so
  //    the tooltip moves in lockstep with the crosshair. The earlier rAF
  //    coalescing introduced a 1-frame lag relative to the uPlot-drawn
  //    crosshair, so during fast mouse moves the tooltip would visibly trail
  //    the line. React 18 already batches state updates within a single
  //    event, which is the only batching this path needs. -------------------

  interface TooltipState {
    idx: number;
    left: number;
    top: number;
    visible: boolean;
  }
  const [tooltip, setTooltip] = useState<TooltipState>({
    idx: -1,
    left: 0,
    top: 0,
    visible: false,
  });

  // flushSync forces React to render in the same tick as the uPlot setCursor
  // hook. Without it, React 18's automatic batching defers the render to the
  // next microtask — uPlot has already drawn its crosshair synchronously, so
  // the tooltip lags by a frame during fast mouse motion. flushSync ties the
  // two renders together.
  const scheduleTooltip = useCallback((next: TooltipState) => {
    flushSync(() => setTooltip(next));
  }, []);

  // -- Attach cursor + scale hooks by mutating options at memo time. The
  //    callbacks close over stable refs (`onZoom`, `plotRef`) so option
  //    identity stays tied to inputs, not closures. ---------------------------

  const onZoomRef = useRef<typeof onZoom>(onZoom);
  useEffect(() => {
    onZoomRef.current = onZoom;
  }, [onZoom]);

  const options = useMemo<uPlot.Options | null>(() => {
    if (!built) return null;
    const base = built.options;

    const setCursor = (u: uPlot): void => {
      const idx = u.cursor.idx;
      const cLeft = u.cursor.left ?? -1;
      const cTop = u.cursor.top ?? -1;
      // "Real mouse over this plot" = our own pointer is physically above
      // the `over` element right now. Can't rely on pointerenter/leave
      // listeners (browser drops them under fast motion) or on
      // applyingExternalRef (uPlot's cursor-sync hub triggers setCursor on
      // receiver panels without going through our subscribe handler). A
      // live CSS :hover match on the over element is the authoritative
      // signal and updates synchronously with the pointer.
      const over = (u as unknown as { over?: HTMLElement }).over;
      const isLocal = !!over && over.matches(':hover');
      if (idx === null || idx === undefined || idx < 0 || cLeft < 0) {
        scheduleTooltip({ idx: -1, left: 0, top: 0, visible: false });
        setHasOwnCursor(false);
        // Only the panel whose own mouse just left should broadcast the
        // clear. Without the `isLocal` gate, a setCursor frame caused by
        // uPlot's sync hub (our own bus publish bouncing via uPlot's x-sync
        // to peers) re-publishes null/non-null and re-syncs the original
        // panel, leaving its crosshair stuck.
        if (!applyingExternalRef.current && isLocal) {
          publishCursor({ ts: null, sourceId, syncKey: syncKey ?? 'prism-panels' });
        }
        return;
      }
      setHasOwnCursor(isLocal);
      // uPlot's cursor coords are relative to its `over` element (the inner
      // plot area, after axes). Tooltip lives in the TimeSeriesViz container,
      // so translate by the over element's offset within the container — else
      // the tooltip's flip math against `containerRef.clientWidth` is off by
      // the y-axis gutter and the tooltip drifts left of the crosshair.
      const containerEl = containerRef.current;
      let absLeft = cLeft;
      let absTop = cTop;
      if (over && containerEl) {
        const overRect = over.getBoundingClientRect();
        const containerRect = containerEl.getBoundingClientRect();
        absLeft = overRect.left - containerRect.left + cLeft;
        absTop = overRect.top - containerRect.top + cTop;
      }
      scheduleTooltip({ idx, left: absLeft, top: absTop, visible: true });
      // Publish to canvas-rendered viz (heatmap) — but only when the cursor
      // change came from THIS chart's user interaction, not from a bus event
      // we just applied. The flag is the loop-breaker: external apply →
      // setCursor → flag is true → no publish → no echo.
      // Only publish when OUR mouse is really in the plot — not when this
      // frame was triggered by uPlot's x-sync hub forwarding a peer's
      // cursor. Without the gate, receiver panels echo every synced frame
      // back to the bus and the original publisher gets stuck in its own
      // reflection.
      if (!applyingExternalRef.current && isLocal) {
        const ts = u.data[0]?.[idx];
        if (typeof ts === 'number') {
          // Report pointer Y as a fraction of the plot area height so
          // other panels can place their horizontal crosshair at the same
          // relative vertical position regardless of their own height.
          const overH = over?.clientHeight ?? 0;
          const topPct = overH > 0 ? Math.max(0, Math.min(1, cTop / overH)) : undefined;
          publishCursor({
            ts,
            topPct,
            sourceId,
            syncKey: syncKey ?? 'prism-panels',
          });
        }
      }
    };

    const setScaleHook = (u: uPlot, scaleKey: string): void => {
      if (scaleKey !== 'x') return;
      const cb = onZoomRef.current;
      if (!cb) return;
      const xScale = u.scales.x;
      if (!xScale || xScale.min === undefined || xScale.max === undefined) return;
      if (xScale.min === null || xScale.max === null) return;
      cb(xScale.min, xScale.max);
    };

    const merged: uPlot.Options = {
      ...base,
      cursor: {
        ...(base.cursor ?? {}),
        // Box-zoom. Horizontal only; vertical selection just feels wrong on a
        // time-series and Grafana's behavior is x-only.
        drag: { x: true, y: false, setScale: true },
        // Shared crosshair across time-series panels — but ONLY on the X
        // scale (time). uPlot's default sync would also shuttle Y between
        // instances, but panels have independent Y scales (ms vs ops/s vs
        // %), so pixel-level Y sync makes the horizontal line stutter and
        // overshoot the mouse on taller sibling panels. Our own window-bus
        // `topPct` handles Y proportionally instead.
        sync: {
          key: syncKey ?? 'prism-panels',
          setSeries: false,
          scales: ['x', null],
        },
      },
      hooks: {
        ...(base.hooks ?? {}),
        setCursor: [
          ...((base.hooks?.setCursor as Array<(u: uPlot) => void> | undefined) ?? []),
          setCursor,
        ],
        setScale: [
          ...((base.hooks?.setScale as Array<(u: uPlot, k: string) => void> | undefined) ?? []),
          setScaleHook,
        ],
      },
      legend: { show: false },
    };
    return merged;
  }, [built, scheduleTooltip, syncKey]);

  // -- Apply visibility toggles to the live plot whenever `hidden` changes. --

  useEffect(() => {
    const plot = plotRef.current;
    const metas = built?.metas;
    if (!plot || !metas) return;
    for (let i = 0; i < metas.length; i += 1) {
      const meta = metas[i]!;
      const isHidden = !!hidden[meta.displayName];
      // uPlot series indices are 1-based (index 0 is the x-series).
      plot.setSeries(i + 1, { show: !isHidden });
    }
  }, [hidden, built]);

  const handleReady = useCallback(
    (plot: uPlot) => {
      plotRef.current = plot;
      // The setCursor hook can't publish the "cursor left" clear reliably:
      // by the time it fires with idx=null, `over.matches(':hover')` is
      // already false, which is exactly the gate we use to distinguish a
      // real local pointer from a uPlot-sync echo. Bind a dedicated
      // pointerleave listener on the over element so the null-publish
      // happens exactly once per real leave, independent of that gate.
      const over = (plot as unknown as { over?: HTMLElement }).over;
      if (!over) return;
      const onLeave = (): void => {
        // Hide the crosshair and tooltip BEFORE uPlot runs its own
        // mouseleave repaint. React state updates are async and the
        // `setTooltip({visible:false})` that the setCursor hook normally
        // issues lands a frame after the pointerleave — long enough for
        // the still-visible tooltip card to flash at its last position.
        // Imperative DOM writes here close that gap for both elements.
        containerRef.current?.classList.add('ts-no-cursor');
        flushSync(() =>
          setTooltip({ idx: -1, left: 0, top: 0, visible: false }),
        );
        setHasOwnCursor(false);
        publishCursor({ ts: null, sourceId, syncKey: syncKey ?? 'prism-panels' });
      };
      over.addEventListener('pointerleave', onLeave);
    },
    [sourceId, syncKey],
  );

  const toggleSeries = useCallback((name: string) => {
    setHidden((prev) => ({ ...prev, [name]: !prev[name] }));
  }, []);

  // -- Empty-state render ----------------------------------------------------

  if (isEmpty || !built || !options) {
    return (
      <div
        className="text-sm text-on-surface-variant flex items-center justify-center"
        style={{ height, padding: '1rem' }}
      >
        No data
      </div>
    );
  }

  const { metas, xs } = built;

  // Always show a legend when there's at least one series — even for single-
  // series-no-labels panels Grafana shows a legend row with Mean / Max / Last
  // stats, which is genuinely useful information. The agent's panel-generation
  // prompt now sets `legendStats` per panel intent; when omitted, we default
  // to a sensible set so the legend never collapses to a bare refId.
  const effectiveLegendStats: LegendStat[] | undefined =
    legendStats && legendStats.length > 0 ? legendStats : ['mean', 'max', 'last'];

  // T-201 — adaptive legend mode by series count AND stat width.
  //  - <= 6 series with ≤1 stat per row → list (compact, single line per item)
  //  - multi-stat × multi-series → table (list mode would cram each row with
  //    "name Mean: x Max: y Last: z" and either wrap awkwardly or overflow,
  //    truncating the right edge — table aligns stats into proper columns)
  //  - > 6 series → table for the same overflow reason
  //  - > 20 series → table AND only the top-N by `last` value, with "+N more"
  //    expander. Otherwise a 100-series legend dominates the panel
  const TOP_N = 15;
  const overflow = Math.max(0, metas.length - TOP_N);
  const [legendExpanded, setLegendExpanded] = useState(false);
  const tooManySeries = metas.length > TOP_N && !legendExpanded;
  const visibleMetas = tooManySeries
    ? [...metas]
        .map((m, idx) => ({ m, idx }))
        // Rank by `last` desc with NaN sinking; preserves stable index for the
        // hidden-state lookup below.
        .sort((a, b) => (b.m.last ?? -Infinity) - (a.m.last ?? -Infinity))
        .slice(0, TOP_N)
        .map(({ m }) => m)
    : metas;
  const statColumns = effectiveLegendStats?.length ?? 0;

  // Single source of truth for sizing. `usePanelLayout` owns the
  // ResizeObserver and projects width/height to a size class; the
  // `decideLegendLayout` pure function maps that + series shape to a
  // concrete legend mode (list / table / stacked / hidden) plus
  // basis. Everything below reads from `legendDecision` — no scattered
  // breakpoints / magic-number widths in this file anymore.
  const panelLayout = usePanelLayout(containerRef);
  const legendDecision = decideLegendLayout(
    panelLayout,
    metas.length,
    statColumns,
    legend,
  );
  const showLegend = legendDecision.mode !== 'hidden';

  // -- Render ----------------------------------------------------------------

  return (
    <div
      ref={containerRef}
      className={`flex h-full w-full flex-col ${hasOwnCursor ? '' : 'ts-passive'} ${
        !hasOwnCursor && !hasSyncedCursor ? 'ts-no-cursor' : ''
      }`}
      style={{ position: 'relative' }}
      onMouseEnter={() => setIsPointerInside(true)}
      onMouseLeave={() => setIsPointerInside(false)}
    >
      <div className="min-h-0 flex-1" style={{ position: 'relative' }}>
        <UPlotChart
          options={options}
          data={built.data}
          onReady={handleReady}
          fillHeight
          className="h-full w-full"
        />
        {annotations && annotations.length > 0 && (
          <AnnotationsLayer
            annotations={annotations}
            plotRef={plotRef}
            containerRef={containerRef}
          />
        )}
      </div>

      {isPointerInside && tooltip.visible && tooltip.idx >= 0 && tooltip.idx < xs.length && (
        <TooltipLayer
          tooltip={tooltip}
          xs={xs}
          metas={metas}
          hidden={hidden}
          unit={unit}
          containerRef={containerRef}
          maxWidth={panelLayout.tooltipMaxWidth}
        />
      )}

      {showLegend && (
        <>
          <LegendLayer
            metas={visibleMetas}
            hidden={hidden}
            onToggle={toggleSeries}
            decision={legendDecision}
            unit={unit}
            stats={effectiveLegendStats}
          />
          {overflow > 0 && (
            <button
              type="button"
              onClick={() => setLegendExpanded((v) => !v)}
              className="self-start text-[11px] text-on-surface-variant hover:text-on-surface px-2 py-1"
              style={{ fontFamily: 'inherit' }}
            >
              {legendExpanded ? `Show top ${TOP_N}` : `…+${overflow} more`}
            </button>
          )}
        </>
      )}
    </div>
  );
}

export default TimeSeriesViz;

// ---------------------------------------------------------------------------
// Annotations overlay — vertical event markers (deploys, incidents, alerts).
// ---------------------------------------------------------------------------

interface AnnotationsLayerProps {
  annotations: PanelAnnotation[];
  plotRef: React.MutableRefObject<uPlot | null>;
  containerRef: React.RefObject<HTMLDivElement | null>;
}

function AnnotationsLayer({
  annotations,
  plotRef,
  containerRef,
}: AnnotationsLayerProps): JSX.Element | null {
  // Re-render on plot size / scale changes so line positions stay aligned.
  // We poll once per animation frame on cursor activity — cheap, bounded by
  // browser frame rate, and avoids subscribing to uPlot's internal hooks.
  const [, force] = useState(0);
  useEffect(() => {
    let raf = 0;
    const tick = (): void => {
      force((n) => (n + 1) % 1_000_000);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  const plot = plotRef.current;
  const container = containerRef.current;
  if (!plot || !container) return null;

  // valToPos returns over-relative pixels. Translate into the chart wrapper's
  // coord system so the line sits next to whatever uPlot draws.
  const over = (plot as unknown as { over?: HTMLElement }).over;
  if (!over) return null;
  const overRect = over.getBoundingClientRect();
  const wrapper = over.parentElement?.parentElement ?? null;
  if (!wrapper) return null;
  const wrapperRect = wrapper.getBoundingClientRect();
  const offsetLeft = overRect.left - wrapperRect.left;
  const overTop = overRect.top - wrapperRect.top;
  const overHeight = overRect.height;

  return (
    <div
      style={{
        position: 'absolute',
        inset: 0,
        pointerEvents: 'none',
        zIndex: 4,
      }}
    >
      {annotations.map((ann, i) => {
        if (!Number.isFinite(ann.time)) return null;
        const xLocal = plot.valToPos(ann.time, 'x');
        if (!Number.isFinite(xLocal) || xLocal < 0 || xLocal > overRect.width) {
          return null;
        }
        const left = offsetLeft + xLocal;
        const color = ann.color ?? 'rgba(193, 128, 255, 0.7)';
        return (
          <div
            key={`ann-${i}`}
            title={`${new Date(ann.time).toLocaleString()} — ${ann.label}`}
            style={{
              position: 'absolute',
              left,
              top: overTop,
              width: 0,
              height: overHeight,
              borderLeft: `1px dashed ${color}`,
              pointerEvents: 'auto',
              cursor: 'help',
            }}
          >
            {/* Tiny color flag at the top so the marker is visible without
                hovering. */}
            <div
              aria-hidden
              style={{
                position: 'absolute',
                top: 0,
                left: -3,
                width: 6,
                height: 6,
                borderRadius: 1,
                background: color,
              }}
            />
          </div>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Tooltip subcomponent.
// ---------------------------------------------------------------------------

interface TooltipLayerProps {
  tooltip: { idx: number; left: number; top: number; visible: boolean };
  xs: number[];
  metas: SeriesMeta[];
  hidden: Record<string, boolean>;
  unit: string | undefined;
  containerRef: React.RefObject<HTMLDivElement | null>;
  /** Container-driven max width — narrow panels get a tighter cap so
   *  the tooltip doesn't overflow visually past the chart edge. */
  maxWidth: number;
}

function TooltipLayer({ tooltip, xs, metas, hidden, unit, containerRef, maxWidth }: TooltipLayerProps): JSX.Element {
  const ts = xs[tooltip.idx];
  const timeLabel =
    typeof ts === 'number'
      ? new Intl.DateTimeFormat(undefined, {
          hour: '2-digit',
          minute: '2-digit',
          second: '2-digit',
        }).format(new Date(ts))
      : '';

  // Place the tooltip just below-right of the crosshair (Grafana style).
  // Flip to below-left when it would overflow the right edge, and above when
  // it would overflow the bottom. Use CSS transforms for the flip so the
  // tooltip's edge sits exactly `TOOLTIP_OFFSET` from the cursor regardless
  // of the tooltip's actual measured width — fixes the "left/right distance
  // is different" bug where a 220px estimate left a gap when the real
  // content was narrower.
  const containerW = containerRef.current?.clientWidth ?? 0;
  const containerH = containerRef.current?.clientHeight ?? 0;
  const TOOLTIP_W_ESTIMATE = 200;
  const visibleSeriesCount = metas.filter((m) => !hidden[m.displayName]).length;
  const TOOLTIP_H_ESTIMATE = 36 + visibleSeriesCount * 22;
  const flipX = containerW > 0 && tooltip.left + TOOLTIP_OFFSET + TOOLTIP_W_ESTIMATE > containerW;
  const flipY = containerH > 0 && tooltip.top + TOOLTIP_OFFSET + TOOLTIP_H_ESTIMATE > containerH;
  // Anchor the tooltip's relevant edge to `cursor ± OFFSET`. Translate moves
  // the box around its anchor so left/right distance is symmetric.
  const left = flipX ? tooltip.left - TOOLTIP_OFFSET : tooltip.left + TOOLTIP_OFFSET;
  const top = flipY ? tooltip.top - TOOLTIP_OFFSET : tooltip.top + TOOLTIP_OFFSET;
  const transform =
    `${flipX ? 'translateX(-100%)' : ''} ${flipY ? 'translateY(-100%)' : ''}`.trim();

  return (
    <div
      className="ts-tooltip"
      style={{
        position: 'absolute',
        left,
        top,
        transform: transform || undefined,
        pointerEvents: 'none',
        zIndex: 10,
      }}
    >
      <div
        style={{
          background: VIZ_TOKENS.tooltip.background,
          border: VIZ_TOKENS.tooltip.border,
          borderRadius: VIZ_TOKENS.tooltip.borderRadius,
          fontSize: VIZ_TOKENS.tooltip.fontSize,
          padding: '6px 8px',
          minWidth: Math.min(160, maxWidth),
          maxWidth,
          color: 'var(--color-on-surface)',
          // Soft drop-shadow. Kept at low alpha so it lands readably on both
          // dark (subtle lift off panel) and light (halo around tooltip).
          boxShadow: '0 4px 12px rgba(0, 0, 0, 0.12)',
        }}
      >
        <div
          style={{
            fontFamily:
              'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
            color: 'var(--color-on-surface-variant)',
            marginBottom: 4,
          }}
        >
          {timeLabel}
        </div>
        {metas.map((meta) => {
          if (hidden[meta.displayName]) return null;
          const raw = meta.values[tooltip.idx];
          const v = raw ?? null;
          return (
            <div
              key={meta.displayName}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                lineHeight: 1.4,
              }}
            >
              <span
                aria-hidden
                style={{
                  display: 'inline-block',
                  width: 8,
                  height: 8,
                  borderRadius: 2,
                  background: meta.color,
                  flexShrink: 0,
                }}
              />
              <span
                style={{
                  flex: 1,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
              >
                {meta.displayName}
              </span>
              <span
                style={{
                  fontFamily:
                    'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
                  fontVariantNumeric: 'tabular-nums',
                  color: 'var(--color-on-surface)',
                }}
              >
                {formatValueForDisplay(v, unit)}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Legend subcomponent.
// ---------------------------------------------------------------------------

interface LegendLayerProps {
  metas: SeriesMeta[];
  hidden: Record<string, boolean>;
  onToggle: (name: string) => void;
  /** Resolved layout decision from `decideLegendLayout`. Carries the
   *  mode (list / table / stacked) and any layout knobs (basis). */
  decision: LegendLayoutDecision;
  unit: string | undefined;
  /** Inline stats per legend entry (list / stacked) or columns (table). */
  stats?: LegendStat[];
}

const STAT_LABELS: Record<LegendStat, string> = {
  last: 'Last',
  mean: 'Mean',
  max: 'Max',
  min: 'Min',
};

const ALL_STATS: LegendStat[] = ['last', 'mean', 'max', 'min'];

const MONO_FONT = 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace';

/**
 * Cap the legend at one third of the chart container so it never crowds out
 * the chart. `overflow-y: auto` lets dense legends scroll. We rely on the
 * parent flex column at `containerRef` setting `min-h-0` on the chart slot
 * (already in place) so this max-height is honored even when the legend
 * could otherwise expand to its content height.
 */
const LEGEND_CONTAINER_STYLE: CSSProperties = {
  marginTop: 8,
  maxHeight: '33%',
  overflowY: 'auto',
  flexShrink: 0,
  // Match the chart's left/right gutter so the legend doesn't visually
  // butt up against the panel edge. The table mode in particular had
  // its color swatch column sitting at x=0 with no breathing room.
  paddingInline: 8,
};

function pickStat(meta: SeriesMeta, stat: LegendStat): number | null {
  return meta[stat];
}

function LegendLayer({
  metas,
  hidden,
  onToggle,
  decision,
  unit,
  stats,
}: LegendLayerProps): JSX.Element | null {
  const { mode, itemBasis } = decision;

  if (mode === 'hidden') return null;

  if (mode === 'table') {
    // Preserve previous behavior when caller didn't specify which columns to
    // show: render all four. When specified, honor the order/subset.
    const columns: LegendStat[] = stats && stats.length > 0 ? stats : ALL_STATS;
    return (
      <div style={{ ...LEGEND_CONTAINER_STYLE, overflowX: 'auto' }}>
        <table
          style={{
            width: '100%',
            borderCollapse: 'collapse',
            fontSize: 12,
            color: 'var(--color-on-surface)',
          }}
        >
          <thead>
            <tr
              style={{
                color: 'var(--color-on-surface-variant)',
                textAlign: 'right',
              }}
            >
              <th style={{ width: 14 }} aria-label="color" />
              <th style={{ textAlign: 'left', fontWeight: 500, padding: '2px 6px' }}>
                Name
              </th>
              {columns.map((col) => (
                <th key={col} style={{ fontWeight: 500, padding: '2px 6px' }}>
                  {STAT_LABELS[col]}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {metas.map((meta) => {
              const isHidden = !!hidden[meta.displayName];
              return (
                <tr
                  key={meta.displayName}
                  onClick={() => onToggle(meta.displayName)}
                  style={{
                    cursor: 'pointer',
                    opacity: isHidden ? 0.35 : 1,
                    textAlign: 'right',
                    fontVariantNumeric: 'tabular-nums',
                  }}
                >
                  <td style={{ padding: '2px 0' }}>
                    <span
                      aria-hidden
                      style={{
                        display: 'inline-block',
                        width: 10,
                        height: 10,
                        borderRadius: 2,
                        background: meta.color,
                      }}
                    />
                  </td>
                  <td
                    style={{
                      textAlign: 'left',
                      padding: '2px 6px',
                      // Bound by `maxWidth: 0 + width: 100%` trick so the
                      // cell shrinks with the table column rather than
                      // hardcoding a pixel cap. Long labels ellipsis;
                      // tooltip-on-hover still gives the full text.
                      maxWidth: 0,
                      width: '100%',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                    title={meta.displayName}
                  >
                    {meta.displayName}
                  </td>
                  {columns.map((col) => (
                    <td
                      key={col}
                      style={{
                        padding: '2px 6px',
                        fontFamily: MONO_FONT,
                        // Without nowrap the cell wraps "44 ms" to two
                        // lines when the name column eats the row width.
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {formatValueForDisplay(pickStat(meta, col), unit)}
                    </td>
                  ))}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    );
  }

  // Default to `['last']` to preserve the pre-T-022 single-value look.
  const inlineStats: LegendStat[] = stats && stats.length > 0 ? stats : ['last'];

  // Stacked mode — narrow panels (< 300 px). Series name owns the first
  // row at full width so CJK / long labels never truncate; stats drop to
  // a second row indented to the swatch column. This is what every
  // mature charting lib does at narrow widths (Grafana, Datadog, etc.).
  if (mode === 'stacked') {
    return (
      <div
        style={{
          ...LEGEND_CONTAINER_STYLE,
          display: 'flex',
          flexDirection: 'column',
          gap: 6,
          fontSize: 12,
          color: 'var(--color-on-surface)',
        }}
      >
        {metas.map((meta) => {
          const isHidden = !!hidden[meta.displayName];
          return (
            <button
              key={meta.displayName}
              type="button"
              onClick={() => onToggle(meta.displayName)}
              style={{
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'stretch',
                gap: 2,
                padding: '2px 4px',
                background: 'transparent',
                border: 'none',
                cursor: 'pointer',
                opacity: isHidden ? 0.35 : 1,
                color: 'inherit',
                font: 'inherit',
                textAlign: 'left',
                width: '100%',
              }}
              title={meta.displayName}
            >
              <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span
                  aria-hidden
                  style={{
                    display: 'inline-block',
                    width: 10,
                    height: 10,
                    borderRadius: 2,
                    background: meta.color,
                    flexShrink: 0,
                  }}
                />
                <span style={{ overflowWrap: 'anywhere', minWidth: 0 }}>
                  {meta.displayName}
                </span>
              </span>
              <span
                style={{
                  display: 'flex',
                  flexWrap: 'wrap',
                  gap: '0 12px',
                  // Indent under the swatch column so the stats line up
                  // with the series name, not the swatch itself.
                  paddingLeft: 18,
                  fontSize: 11,
                  color: 'var(--color-on-surface-variant)',
                }}
              >
                {inlineStats.map((stat) => (
                  <LegendStatChip
                    key={stat}
                    stat={stat}
                    value={pickStat(meta, stat)}
                    unit={unit}
                    showLabel={inlineStats.length > 1 || stat !== 'last'}
                  />
                ))}
              </span>
            </button>
          );
        })}
      </div>
    );
  }

  // mode === 'list' (medium / wide). itemBasis comes from layout
  // decision: 140 on medium, 220 on wide. minWidth: 0 lets ellipsis
  // kick in when the name genuinely doesn't fit; this is fine in list
  // mode because there's enough horizontal room. Stacked mode catches
  // the CJK truncation case before we get here.
  return (
    <div
      style={{
        ...LEGEND_CONTAINER_STYLE,
        display: 'flex',
        flexWrap: 'wrap',
        gap: '4px 12px',
        fontSize: 12,
        color: 'var(--color-on-surface)',
      }}
    >
      {metas.map((meta) => {
        const isHidden = !!hidden[meta.displayName];
        return (
          <button
            key={meta.displayName}
            type="button"
            onClick={() => onToggle(meta.displayName)}
            style={{
              flex: `1 1 ${itemBasis}px`,
              minWidth: 0,
              maxWidth: '100%',
              display: 'inline-flex',
              alignItems: 'center',
              gap: 8,
              padding: '2px 4px',
              background: 'transparent',
              border: 'none',
              cursor: 'pointer',
              opacity: isHidden ? 0.35 : 1,
              color: 'inherit',
              font: 'inherit',
              textAlign: 'left',
            }}
            title={meta.displayName}
          >
            <span
              aria-hidden
              style={{
                display: 'inline-block',
                width: 10,
                height: 10,
                borderRadius: 2,
                background: meta.color,
                flexShrink: 0,
              }}
            />
            <span
              style={{
                flex: 1,
                minWidth: 0,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              {meta.displayName}
            </span>
            {inlineStats.map((stat, idx) => (
              <LegendStatChip
                key={stat}
                stat={stat}
                value={pickStat(meta, stat)}
                unit={unit}
                showLabel={inlineStats.length > 1}
                marginLeft={idx === 0 ? 0 : 8}
              />
            ))}
          </button>
        );
      })}
    </div>
  );
}

/**
 * One stat reading inside a legend item. Shared between list and
 * stacked modes. Pulled out so both modes render numbers identically:
 * monospace, tabular-nums, optional `Mean:` label prefix.
 */
function LegendStatChip({
  stat,
  value,
  unit,
  showLabel,
  marginLeft,
}: {
  stat: LegendStat;
  value: number | null;
  unit: string | undefined;
  showLabel: boolean;
  marginLeft?: number;
}): JSX.Element {
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'baseline',
        gap: 4,
        marginLeft: marginLeft ?? 0,
        flexShrink: 0,
      }}
    >
      {showLabel && (
        <span style={{ fontSize: 11, color: 'var(--color-on-surface-variant)' }}>
          {STAT_LABELS[stat]}:
        </span>
      )}
      <span
        style={{
          fontFamily: MONO_FONT,
          fontVariantNumeric: 'tabular-nums',
          color: showLabel ? 'var(--color-on-surface)' : 'var(--color-on-surface-variant)',
        }}
      >
        {formatValueForDisplay(value, unit)}
      </span>
    </span>
  );
}

// Silence unused-import warning: `getFieldDisplayName` is re-exported for
// downstream callers that want to compose legends from raw DataFrames.
void getFieldDisplayName;
