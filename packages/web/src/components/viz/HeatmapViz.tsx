/**
 * HeatmapViz — canvas-rendered heatmap for prism.
 *
 * Why canvas: heatmaps routinely hit thousands of cells (e.g. 300 timestamps ×
 * 40 buckets = 12k rects). SVG/DOM nodes at that count hurt scroll and layout;
 * a single `<canvas>` paints in one pass and scales to DPR for crispness.
 *
 * Design notes:
 *  - Color ramp is derived from `PALETTE[hue]` (5 shades). We lerp in RGB
 *    between adjacent shades across 4 bands, driven by normalized value `t`.
 *  - Tooltip lives as a React overlay div (easier styling + pointer-events
 *    discipline) while cells + axis labels are painted to the canvas.
 *  - Sibling of `HeatmapVisualization.tsx`; that legacy component is left
 *    untouched for back-compat with older dashboards.
 */
import React, { useEffect, useId, useMemo, useRef, useState } from 'react';
import { formatValueForDisplay } from '../../lib/format/index.js';
import { PALETTE, VIZ_TOKENS, resolveCssVar, type Hue } from '../../lib/theme/index.js';
import { publishCursor, subscribeCursor } from '../../lib/viz-sync/cursor-sync.js';

export interface HeatmapPoint {
  /** Timestamp in ms since epoch. */
  x: number;
  /** Bucket / row label. First-seen order is preserved. */
  y: string;
  value: number;
}

export interface HeatmapVizProps {
  points: HeatmapPoint[];
  /** Formatter id (e.g. `'bytes'`, `'percent'`). */
  unit?: string;
  /** Hue for the color ramp. Default `'blue'`. */
  hue?: Extract<Hue, 'blue' | 'purple' | 'green' | 'orange' | 'red'>;
  /**
   * Fixed pixel height. When omitted, the canvas tracks its container's
   * height — this is the right default inside dashboard panels that own
   * their own height. Pass an explicit value for fixed-height embeds.
   */
  height?: number;
  /**
   * Color ramp scale. Default `'sqrt'` — linear is rarely the right choice
   * because heatmap data is typically heavy-tailed (one hot cell collapses
   * everything else into the lightest band).
   */
  colorScale?: 'linear' | 'sqrt' | 'log';
  /**
   * Cross-panel cursor sync key. Defaults to `'prism-panels'`, the same key
   * uPlot-based panels use, so a heatmap shares its crosshair time with every
   * time-series panel on the dashboard.
   */
  syncKey?: string;
  /**
   * For histogram-mode heatmaps (every y label is an `le` bucket), drop rows
   * whose every cell is 0 — keeping the lowest occupied bucket and one row
   * above the highest occupied bucket as visual headroom. Default `true`.
   * Set `false` to render every bucket (rare; useful when comparing two
   * heatmaps side-by-side and the y axes need to align exactly).
   */
  collapseEmptyBuckets?: boolean;
}

const PAD_LEFT = 60;
// x-axis labels (14) + gap (2) + totals strip (10) + gap (6)
const PAD_BOTTOM = 32;
const PAD_TOP = 8;
const PAD_RIGHT = 8;
// Height of the per-column totals strip rendered below the x-axis labels.
const TOTALS_H = 10;
const TOTALS_GAP_TOP = 2;
const AXIS_FONT = `11px system-ui, -apple-system, Segoe UI, sans-serif`;
const TICK_FONT = `10px system-ui, -apple-system, Segoe UI, sans-serif`;

interface Rgb {
  r: number;
  g: number;
  b: number;
}

function hexToRgb(hex: string): Rgb {
  const h = hex.replace('#', '');
  const n =
    h.length === 3
      ? h
          .split('')
          .map((c) => c + c)
          .join('')
      : h;
  const v = parseInt(n, 16);
  // `>>>` keeps the result in the unsigned 32-bit range.
  return {
    r: (v >>> 16) & 0xff,
    g: (v >>> 8) & 0xff,
    b: v & 0xff,
  };
}

function rgbToCss({ r, g, b }: Rgb): string {
  return `rgb(${r | 0}, ${g | 0}, ${b | 0})`;
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function lerpRgb(a: Rgb, b: Rgb, t: number): Rgb {
  return { r: lerp(a.r, b.r, t), g: lerp(a.g, b.g, t), b: lerp(a.b, b.b, t) };
}

/** Format a timestamp as `HH:MM` in local time. */
function formatTime(ts: number): string {
  const d = new Date(ts);
  const hh = d.getHours().toString().padStart(2, '0');
  const mm = d.getMinutes().toString().padStart(2, '0');
  return `${hh}:${mm}`;
}

/** Clip `text` to `maxPx` using `ctx.measureText`, appending an ellipsis. */
function clipText(
  ctx: CanvasRenderingContext2D,
  text: string,
  maxPx: number,
): string {
  if (ctx.measureText(text).width <= maxPx) return text;
  const ellipsis = '\u2026';
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (ctx.measureText(text.slice(0, mid) + ellipsis).width <= maxPx) {
      lo = mid;
    } else {
      hi = mid - 1;
    }
  }
  return lo <= 0 ? ellipsis : text.slice(0, lo) + ellipsis;
}

interface Prepared {
  xs: number[];
  ys: string[];
  lookup: Map<string, number>;
  min: number;
  max: number;
  hasData: boolean;
}

function prepare(
  points: HeatmapPoint[],
  collapseEmptyBuckets: boolean,
): Prepared {
  if (points.length === 0) {
    return {
      xs: [],
      ys: [],
      lookup: new Map(),
      min: 0,
      max: 0,
      hasData: false,
    };
  }
  const xSet = new Set<number>();
  const ySeen = new Set<string>();
  const ys: string[] = [];
  const lookup = new Map<string, number>();
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  let sawNonZero = false;
  for (const p of points) {
    if (!Number.isFinite(p.x)) continue;
    xSet.add(p.x);
    if (!ySeen.has(p.y)) {
      ySeen.add(p.y);
      ys.push(p.y);
    }
    lookup.set(`${p.x}|${p.y}`, p.value);
    if (Number.isFinite(p.value)) {
      if (p.value > max) max = p.value;
      if (p.value !== 0 && p.value < min) {
        min = p.value;
        sawNonZero = true;
      }
    }
  }
  if (!sawNonZero) {
    // All zeros (or NaN). Anchor min at 0 so the ramp still renders sensibly.
    min = 0;
  }
  if (!Number.isFinite(max)) max = 0;
  if (!Number.isFinite(min)) min = 0;
  const xs = [...xSet].sort((a, b) => a - b);
  // Detect histogram-style numeric bucket labels (e.g. Prometheus `le`
  // values: "0.1", "0.5", "+Inf"). When every label parses as a number or
  // "+Inf", sort numerically with larger buckets on top — smaller at bottom —
  // so the plot reads like a histogram. Non-numeric labels keep first-seen
  // order.
  const ysSorted = sortBucketLabels(ys);
  const ysFinal = collapseEmptyBuckets
    ? collapseEmptyHistogramRows(ysSorted, xs, lookup)
    : ysSorted;
  return { xs, ys: ysFinal, lookup, min, max, hasData: true };
}

/**
 * For histogram-mode heatmaps, drop rows whose every cell is 0 — keeping the
 * lowest occupied bucket and ONE row above the highest occupied bucket as
 * visual headroom (so the user sees there ARE more buckets above and the
 * single bright row isn't ambiguous).
 *
 * `ysSorted` is in visual order (largest `le` at index 0, smallest at the
 * bottom). The "highest occupied bucket" is therefore the lowest index with
 * data, and the "lowest occupied bucket" is the highest such index.
 *
 * Returns `ysSorted` unchanged when:
 *   - the labels aren't all numeric / `±Inf` (not histogram mode)
 *   - every row is empty (degenerate; preserve original)
 */
function collapseEmptyHistogramRows(
  ysSorted: string[],
  xs: number[],
  lookup: Map<string, number>,
): string[] {
  if (ysSorted.length === 0) return ysSorted;
  const isBucket = (s: string): boolean =>
    s === '+Inf' || s === '-Inf' || Number.isFinite(parseFloat(s));
  if (!ysSorted.every(isBucket)) return ysSorted;
  // Per-row "has any non-zero finite value" map.
  const hasData: boolean[] = ysSorted.map((row) => {
    for (const x of xs) {
      const v = lookup.get(`${x}|${row}`);
      if (v !== undefined && Number.isFinite(v) && v !== 0) return true;
    }
    return false;
  });
  // Highest occupied bucket = first non-empty from the top of the visual
  // (lowest index). Lowest occupied bucket = first non-empty from the bottom
  // (highest index).
  let topIdx = -1;
  let bottomIdx = -1;
  for (let i = 0; i < hasData.length; i++) {
    if (hasData[i]) {
      if (topIdx === -1) topIdx = i;
      bottomIdx = i;
    }
  }
  if (topIdx === -1) return ysSorted; // all empty — keep as-is
  // Ensure at least MIN_VISIBLE rows are shown so the heatmap reads as a
  // proper grid rather than 2–3 thick bands when data is concentrated in
  // one or two buckets. Extra rows are split above the highest occupied
  // bucket (as headroom) and below the lowest (as tailroom) for a balanced
  // look that matches Grafana's default proportions.
  const MIN_VISIBLE = 8;
  const occupied = bottomIdx - topIdx + 1;
  const extra = Math.max(0, MIN_VISIBLE - occupied);
  const headroom = Math.ceil(extra / 2) + 1; // always leave ≥1 empty row up top
  const tailroom = Math.floor(extra / 2);
  const start = Math.max(0, topIdx - headroom);
  const end = Math.min(ysSorted.length, bottomIdx + 1 + tailroom);
  return ysSorted.slice(start, end);
}

function sortBucketLabels(ys: string[]): string[] {
  const isBucket = (s: string): boolean =>
    s === '+Inf' || s === '-Inf' || Number.isFinite(parseFloat(s));
  if (!ys.every(isBucket)) return ys;
  return [...ys].sort((a, b) => {
    if (a === b) return 0;
    if (a === '+Inf') return -1; // +Inf on top (index 0 renders at top)
    if (b === '+Inf') return 1;
    if (a === '-Inf') return 1;
    if (b === '-Inf') return -1;
    return parseFloat(b) - parseFloat(a); // descending: larger on top
  });
}

/**
 * Pick a color for normalized `t` in [0, 1] across 5 palette shades (4 bands).
 *
 * `t <= 0` returns `null` meaning "render the empty/surface color".
 */
function rampColor(t: number, shades: [Rgb, Rgb, Rgb, Rgb, Rgb]): string | null {
  if (!Number.isFinite(t) || t <= 0) return null;
  const clamped = t >= 1 ? 1 : t;
  const pos = clamped * 4; // 0..4 across 5 stops
  const idx = Math.min(3, Math.floor(pos));
  const frac = pos - idx;
  const a = shades[idx];
  const b = shades[idx + 1];
  // Bounds above guarantee both exist; fall through just in case.
  if (!a || !b) return null;
  return rgbToCss(lerpRgb(a, b, frac));
}

/**
 * Reshape a normalized value `t in [0,1]` so a long-tailed distribution still
 * fills the color ramp. `sqrt` lifts mid-low values; `log` is more aggressive
 * for very skewed data. `linear` is identity.
 */
function applyColorScale(
  t: number,
  scale: 'linear' | 'sqrt' | 'log',
): number {
  if (!Number.isFinite(t) || t <= 0) return 0;
  const clamped = t >= 1 ? 1 : t;
  if (scale === 'sqrt') return Math.sqrt(clamped);
  if (scale === 'log') return Math.log1p(clamped * (Math.E - 1));
  return clamped;
}

export default function HeatmapViz({
  points,
  unit,
  hue = 'blue',
  height: heightProp,
  colorScale = 'sqrt',
  syncKey = 'prism-panels',
  collapseEmptyBuckets = true,
}: HeatmapVizProps): React.JSX.Element {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const sourceId = useId();
  const [size, setSize] = useState<{ w: number; h: number }>({ w: 0, h: heightProp ?? 260 });
  const [tooltip, setTooltip] = useState<
    | {
        left: number;
        top: number;
        flipX: boolean;
        flipY: boolean;
        time: string;
        bucket: string;
        value: string;
      }
    | null
  >(null);
  // Pixel x/y of the crosshair lines. `null` hides each line. Tracked
  // separately from the tooltip so external (synced) cursor events can show
  // the vertical line without summoning a tooltip. The horizontal line only
  // appears for local hover — synced events carry only a timestamp, not a
  // bucket row.
  const [cursorX, setCursorX] = useState<number | null>(null);
  const [cursorY, setCursorY] = useState<number | null>(null);

  const prepared = useMemo(
    () => prepare(points, collapseEmptyBuckets),
    [points, collapseEmptyBuckets],
  );

  // Palette → RGB stops for the active hue, computed once per hue change.
  const shades = useMemo<[Rgb, Rgb, Rgb, Rgb, Rgb]>(() => {
    const p = PALETTE[hue];
    return [
      hexToRgb(p.superLight),
      hexToRgb(p.light),
      hexToRgb(p.base),
      hexToRgb(p.dark),
      hexToRgb(p.superDark),
    ];
  }, [hue]);

  // Track container size so canvas pixels match layout pixels × DPR. Both
  // dimensions track the container by default — fixed `height` overrides.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    setSize({
      w: Math.max(0, Math.floor(rect.width)),
      h: heightProp ?? (Math.max(0, Math.floor(rect.height)) || 260),
    });
    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const w = Math.max(0, Math.floor(entry.contentRect.width));
        const h = Math.max(0, Math.floor(entry.contentRect.height));
        setSize({ w, h: heightProp ?? (h > 0 ? h : 260) });
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [heightProp]);

  // Paint the canvas whenever size, data, hue, or scale changes.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const { w, h } = size;
    if (w <= 0 || h <= 0) return;

    // DPR scaling: canvas internal buffer runs at DPR×; we then scale the
    // drawing context so all downstream coordinates are in CSS pixels.
    const dpr = Math.max(1, window.devicePixelRatio || 1);
    canvas.width = Math.floor(w * dpr);
    canvas.height = Math.floor(h * dpr);
    canvas.style.width = `${w}px`;
    canvas.style.height = `${h}px`;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    const axisColor = resolveCssVar(VIZ_TOKENS.axis.color);
    const emptyFill = resolveCssVar('var(--color-outline-variant)') || axisColor;

    const { xs, ys, lookup, min, max, hasData } = prepared;
    if (!hasData || xs.length === 0 || ys.length === 0) {
      ctx.fillStyle = axisColor;
      ctx.font = AXIS_FONT;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('No data', w / 2, h / 2);
      return;
    }

    const plotX = PAD_LEFT;
    const plotY = PAD_TOP;
    const plotW = Math.max(1, w - PAD_LEFT - PAD_RIGHT);
    const plotH = Math.max(1, h - PAD_TOP - PAD_BOTTOM);
    const colW = plotW / xs.length;
    const rowH = plotH / ys.length;

    const range = max - min;

    // --- Cells ---
    for (let yi = 0; yi < ys.length; yi++) {
      const row = ys[yi];
      if (row === undefined) continue;
      for (let xi = 0; xi < xs.length; xi++) {
        const col = xs[xi];
        if (col === undefined) continue;
        const v = lookup.get(`${col}|${row}`);
        const px = plotX + xi * colW;
        const py = plotY + yi * rowH;
        // Add 0.5px overdraw so adjacent cells don't show hairline gaps from
        // fractional widths; cheaper than snapping every coordinate.
        const cw = colW + 0.5;
        const rh = rowH + 0.5;
        if (v === undefined || !Number.isFinite(v)) {
          ctx.fillStyle = emptyFill;
          ctx.fillRect(px, py, cw, rh);
          continue;
        }
        const tLinear = range > 0 ? (v - min) / range : v > 0 ? 1 : 0;
        const t = applyColorScale(tLinear, colorScale);
        const fill = rampColor(t, shades);
        if (fill === null) {
          ctx.fillStyle = emptyFill;
        } else {
          ctx.fillStyle = fill;
        }
        ctx.fillRect(px, py, cw, rh);
      }
    }

    // --- Y-axis labels (right-aligned in the gutter) ---
    ctx.fillStyle = axisColor;
    ctx.font = AXIS_FONT;
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    const maxLabelPx = PAD_LEFT - 8;
    // If rows are too small, skip to every Nth label.
    const minLabelSpacing = 12;
    const yStride = Math.max(1, Math.ceil(minLabelSpacing / rowH));
    // For histogram heatmaps, decorate numeric bucket labels with the panel
    // unit so a latency heatmap reads "100ms / 1s / +Inf" rather than raw
    // numbers.
    const isHistogram =
      ys.length > 0 &&
      ys.every((y) => y === '+Inf' || y === '-Inf' || Number.isFinite(parseFloat(y)));
    for (let yi = 0; yi < ys.length; yi += yStride) {
      const label = ys[yi];
      if (label === undefined) continue;
      const yPx = plotY + yi * rowH + rowH / 2;
      let display = label;
      if (isHistogram && unit && label !== '+Inf' && label !== '-Inf') {
        const n = parseFloat(label);
        if (Number.isFinite(n)) display = formatValueForDisplay(n, unit);
      }
      ctx.fillText(clipText(ctx, display, maxLabelPx), PAD_LEFT - 6, yPx);
    }

    // --- X-axis labels (centered under every Nth column) ---
    ctx.font = TICK_FONT;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    // Target ~60px between label centers so they don't collide.
    const xStride = Math.max(1, Math.ceil(60 / colW));
    for (let xi = 0; xi < xs.length; xi += xStride) {
      const ts = xs[xi];
      if (ts === undefined) continue;
      const xPx = plotX + xi * colW + colW / 2;
      ctx.fillText(formatTime(ts), xPx, plotY + plotH + 6);
    }

    // --- Per-column totals strip (bottom density bar) ---
    // Each column sums all bucket values at that timestamp; the strip is
    // colored by that sum on the same ramp as the main heatmap, so darker
    // bands read as "more activity at this moment". Gives at-a-glance "when
    // was traffic peak" info that's painful to eyeball from the main cells.
    const colTotals = xs.map((col) => {
      let sum = 0;
      for (const row of ys) {
        const v = lookup.get(`${col}|${row}`);
        if (typeof v === 'number' && Number.isFinite(v)) sum += v;
      }
      return sum;
    });
    let totalsMax = 0;
    for (const t of colTotals) if (t > totalsMax) totalsMax = t;
    if (totalsMax > 0) {
      const stripY = plotY + plotH + 14 + TOTALS_GAP_TOP; // 14 ≈ x-label text height
      for (let xi = 0; xi < xs.length; xi++) {
        const total = colTotals[xi] ?? 0;
        const px = plotX + xi * colW;
        const tLin = total / totalsMax;
        const t = applyColorScale(tLin, colorScale);
        const fill = rampColor(t, shades);
        ctx.fillStyle = fill ?? emptyFill;
        ctx.fillRect(px, stripY, colW + 0.5, TOTALS_H);
      }
    }
  }, [size, prepared, shades, colorScale]);

  function handleMouseMove(e: React.MouseEvent<HTMLCanvasElement>): void {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container) return;
    const rect = canvas.getBoundingClientRect();
    const cx = e.clientX - rect.left;
    const cy = e.clientY - rect.top;
    const { w, h } = size;
    const { xs, ys, lookup } = prepared;
    if (!prepared.hasData || xs.length === 0 || ys.length === 0) return;
    const plotX = PAD_LEFT;
    const plotY = PAD_TOP;
    const plotW = Math.max(1, w - PAD_LEFT - PAD_RIGHT);
    const plotH = Math.max(1, h - PAD_TOP - PAD_BOTTOM);
    if (cx < plotX || cx >= plotX + plotW || cy < plotY || cy >= plotY + plotH) {
      if (tooltip !== null) setTooltip(null);
      setCursorX(null);
      setCursorY(null);
      publishCursor({ ts: null, sourceId, syncKey });
      return;
    }
    const colW = plotW / xs.length;
    const rowH = plotH / ys.length;
    const xi = Math.min(xs.length - 1, Math.max(0, Math.floor((cx - plotX) / colW)));
    const yi = Math.min(ys.length - 1, Math.max(0, Math.floor((cy - plotY) / rowH)));
    const col = xs[xi];
    const row = ys[yi];
    if (col === undefined || row === undefined) return;
    const v = lookup.get(`${col}|${row}`);
    // Snap the crosshair to the center of the hovered cell.
    setCursorX(plotX + (xi + 0.5) * colW);
    setCursorY(plotY + (yi + 0.5) * rowH);
    // Broadcast the cell's timestamp AND the pointer's relative Y position
    // (as a fraction of the plot area) so subscribing time-series panels
    // place their horizontal crosshair at the same proportional height.
    const topPct = Math.max(0, Math.min(1, (cy - plotY) / plotH));
    publishCursor({ ts: col, topPct, sourceId, syncKey });
    const containerRect = container.getBoundingClientRect();
    // Cells are counts (req/s, ops/s); the panel-level `unit` describes the
    // bucket boundaries (e.g. "s" for latency), NOT the cell value. Format the
    // cell as a bare/short number; decorate the bucket label with the unit so
    // the user reads "≤0.1s" rather than just "0.1".
    const isHistogram =
      ys.length > 0 &&
      ys.every((y) => y === '+Inf' || y === '-Inf' || Number.isFinite(parseFloat(y)));
    const bucketLabel = isHistogram && unit ? `≤${formatValueForDisplay(parseFloat(row), unit)}` : row;
    // Smart placement: flip to the opposite side of the cursor when the
    // tooltip would overflow the container edge. Instead of subtracting a
    // fixed TOOLTIP_W estimate (which visibly gaps when the rendered
    // tooltip is narrower than the estimate), anchor the tooltip's
    // relevant edge at cursor±OFFSET and let CSS transform peg the box
    // to its real rendered width — same approach as TimeSeriesViz.
    const TOOLTIP_W_ESTIMATE = 160;
    const TOOLTIP_H_ESTIMATE = 76;
    const OFFSET = 12;
    const cursorLeft = e.clientX - containerRect.left;
    const cursorTop = e.clientY - containerRect.top;
    const flipX = cursorLeft + OFFSET + TOOLTIP_W_ESTIMATE > containerRect.width;
    const flipY = cursorTop + OFFSET + TOOLTIP_H_ESTIMATE > containerRect.height;
    setTooltip({
      left: flipX ? cursorLeft - OFFSET : cursorLeft + OFFSET,
      top: flipY ? cursorTop - OFFSET : cursorTop + OFFSET,
      flipX,
      flipY,
      time: formatTime(col),
      bucket: bucketLabel === '≤NaN' ? row : bucketLabel,
      value:
        v === undefined || !Number.isFinite(v)
          ? '—'
          : formatValueForDisplay(v, 'short'),
    });
  }

  function handleMouseLeave(): void {
    setTooltip(null);
    setCursorX(null);
    setCursorY(null);
    publishCursor({ ts: null, sourceId, syncKey });
  }

  // Subscribe to cross-panel cursor events so an external panel hovered by
  // the user causes our crosshair to track the matching column. We
  // intentionally do NOT show the tooltip — that would be visually noisy
  // when the user's pointer is over a different panel.
  useEffect(() => {
    return subscribeCursor(syncKey, sourceId, (detail) => {
      if (detail.ts === null) {
        setCursorX(null);
        setCursorY(null);
        return;
      }
      const { w, h } = size;
      if (w <= 0 || h <= 0) return;
      // Map publisher's Y-fraction onto our own plot area so the horizontal
      // line tracks the source's pointer. Fall back to hidden when no
      // fraction was reported.
      const plotH = Math.max(1, h - PAD_TOP - PAD_BOTTOM);
      if (typeof detail.topPct === 'number') {
        setCursorY(PAD_TOP + detail.topPct * plotH);
      } else {
        setCursorY(null);
      }
      const { xs, hasData } = prepared;
      if (!hasData || xs.length === 0) return;
      const plotW = Math.max(1, w - PAD_LEFT - PAD_RIGHT);
      const colW = plotW / xs.length;
      // Snap to the nearest cell center: find the column whose center is
      // closest to the published timestamp on the data axis.
      let bestIdx = 0;
      let bestDiff = Infinity;
      for (let i = 0; i < xs.length; i += 1) {
        const t = xs[i];
        if (t === undefined) continue;
        const d = Math.abs(t - detail.ts);
        if (d < bestDiff) {
          bestDiff = d;
          bestIdx = i;
        }
      }
      setCursorX(PAD_LEFT + (bestIdx + 0.5) * colW);
    });
  }, [syncKey, sourceId, prepared, size]);

  return (
    <div
      ref={containerRef}
      style={{ position: 'relative', width: '100%', height: heightProp ?? '100%' }}
    >
      <canvas
        ref={canvasRef}
        onMouseMove={handleMouseMove}
        onMouseLeave={handleMouseLeave}
        style={{ display: 'block', width: '100%', height: '100%' }}
      />
      {cursorX !== null && (
        <div
          aria-hidden
          style={{
            position: 'absolute',
            left: cursorX,
            top: PAD_TOP,
            width: 0,
            height: `calc(100% - ${PAD_TOP + PAD_BOTTOM}px)`,
            // Dashed to match uPlot's crosshair style on neighbouring
            // time_series panels — a solid line here looked inconsistent
            // during cross-panel sync.
            borderLeft: `1px dashed ${resolveCssVar('var(--color-on-surface-variant)')}`,
            opacity: 0.55,
            pointerEvents: 'none',
            zIndex: 5,
          }}
        />
      )}
      {cursorY !== null && (
        <div
          aria-hidden
          style={{
            position: 'absolute',
            left: PAD_LEFT,
            top: cursorY,
            width: `calc(100% - ${PAD_LEFT + PAD_RIGHT}px)`,
            height: 0,
            borderTop: `1px dashed ${resolveCssVar('var(--color-on-surface-variant)')}`,
            opacity: 0.55,
            pointerEvents: 'none',
            zIndex: 5,
          }}
        />
      )}
      {tooltip && (
        <div
          style={{
            position: 'absolute',
            left: tooltip.left,
            top: tooltip.top,
            transform: `${tooltip.flipX ? 'translateX(-100%)' : ''} ${
              tooltip.flipY ? 'translateY(-100%)' : ''
            }`.trim() || undefined,
            pointerEvents: 'none',
            background: VIZ_TOKENS.tooltip.background,
            border: VIZ_TOKENS.tooltip.border,
            borderRadius: VIZ_TOKENS.tooltip.borderRadius,
            fontSize: VIZ_TOKENS.tooltip.fontSize,
            color: 'var(--color-on-surface)',
            padding: '6px 10px',
            whiteSpace: 'nowrap',
            boxShadow: '0 4px 14px rgba(0, 0, 0, 0.35)',
            zIndex: 10,
          }}
        >
          <div style={{ color: VIZ_TOKENS.axis.color, fontSize: 10 }}>
            {tooltip.time}
          </div>
          <div style={{ fontWeight: 500 }}>{tooltip.bucket}</div>
          <div>{tooltip.value}</div>
        </div>
      )}
    </div>
  );
}
