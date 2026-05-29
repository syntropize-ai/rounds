/**
 * BarViz — top-N bar chart rendered with pure SVG.
 *
 * Intentionally avoids chart libraries so we control every pixel: axis
 * layout, label truncation, threshold-driven color, and hover tint all
 * live in this file. Sibling of the legacy `BarVisualization.tsx` (which
 * stays in place for back-compat with older dashboards).
 *
 * Geometry cheat sheet:
 *  - Horizontal (default): a left label gutter holds right-aligned, truncated
 *    category labels; bars extend to the right; value labels sit just past
 *    the bar end. Gutter width = clamp(80, 30% of chart width, 220).
 *  - Vertical: bars rise from a baseline; category labels sit below the
 *    axis and rotate 30° when there are more than 6 bars so they don't
 *    collide. Left gutter fits formatted tick labels (~44px).
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { formatValueForDisplay } from '../../lib/format/index.js';
import {
  VIZ_TOKENS,
  getSeriesColor,
  resolveThresholdColor,
  type Threshold,
} from '../../lib/theme/index.js';

export interface BarItem {
  label: string;
  value: number;
  color?: string;
}

export interface BarVizProps {
  items: BarItem[];
  /** Formatter id (e.g. `'bytes'`, `'percent'`). */
  unit?: string;
  thresholds?: Threshold[];
  /** Default `'horizontal'` — best for long category labels. */
  orientation?: 'horizontal' | 'vertical';
  /** Cap the number of bars rendered. Default `15`. */
  maxItems?: number;
  /** Render the formatted value at the bar end. Default `true`. */
  showValues?: boolean;
  /** Sort descending by value before slicing. Default `true`. */
  sortDesc?: boolean;
  /** Pixel height of the SVG. Default `240`. */
  height?: number;
}

/** Character budget for inline (non-tooltip) label text. */
const LABEL_CHAR_BUDGET = 24;

/** Bar gap fraction (0..1) of each category band. */
const BAR_BAND_GAP = 0.25;

/** Multiplier applied to max(values) for axis headroom. */
const AXIS_HEADROOM = 1.08;

function truncate(label: string, max: number): string {
  if (label.length <= max) return label;
  // Reserve 1 char for the ellipsis glyph.
  return `${label.slice(0, Math.max(0, max - 1))}\u2026`;
}

/** "Nice" tick generator producing 4–5 round ticks covering [min, max]. */
function niceTicks(min: number, max: number, target = 4): number[] {
  if (!Number.isFinite(min) || !Number.isFinite(max) || max === min) {
    return [min];
  }
  const range = max - min;
  const roughStep = range / Math.max(1, target);
  const pow10 = Math.pow(10, Math.floor(Math.log10(roughStep)));
  const normalized = roughStep / pow10;
  let step: number;
  if (normalized >= 5) step = 10 * pow10;
  else if (normalized >= 2) step = 5 * pow10;
  else if (normalized >= 1) step = 2 * pow10;
  else step = pow10;
  const start = Math.floor(min / step) * step;
  const end = Math.ceil(max / step) * step;
  const ticks: number[] = [];
  for (let v = start; v <= end + step * 0.5; v += step) {
    // Trim floating-point dust.
    ticks.push(Number(v.toPrecision(12)));
  }
  return ticks;
}

interface Prepared extends BarItem {
  displayLabel: string;
  fill: string;
}

function prepareItems(
  items: BarItem[],
  thresholds: Threshold[] | undefined,
  sortDesc: boolean,
  maxItems: number,
): { prepared: Prepared[]; overflowCount: number } {
  // Always sort desc when truncation is in play so the "+N more" tail
  // really represents the smallest items, not whatever order they arrived in.
  const willTruncate = items.length > Math.max(0, maxItems);
  const sorted = sortDesc || willTruncate
    ? [...items].sort((a, b) => b.value - a.value)
    : items;
  const cap = Math.max(0, maxItems);
  const clipped = sorted.slice(0, cap);
  const overflowCount = Math.max(0, sorted.length - cap);
  const prepared = clipped.map((it, idx) => ({
    ...it,
    displayLabel: truncate(it.label, LABEL_CHAR_BUDGET),
    fill:
      it.color ??
      resolveThresholdColor(it.value, thresholds, getSeriesColor(idx)),
  }));
  return { prepared, overflowCount };
}

/** Lighten a CSS color by compositing with white at `amount` opacity. */
function hoverTint(color: string): string {
  // Works for any color format: layered white overlay via filter is hard in
  // pure SVG, so instead we swap to a slightly transparent, brighter render
  // by stacking an additional opaque rect in the caller. But simpler and
  // still polished: bump fill-opacity down so the bar appears lighter
  // against the surface. Implemented via `fillOpacity` on the element;
  // return value kept for API symmetry in case we switch to color math.
  return color;
}

export default function BarViz({
  items,
  unit,
  thresholds,
  orientation = 'horizontal',
  maxItems = 15,
  showValues = true,
  sortDesc = true,
  height: heightProp,
}: BarVizProps): React.JSX.Element {
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  // Track both width AND height so the SVG fills the panel without overflowing
  // (which `overflow-hidden` would clip), and bars keep their proportions
  // regardless of how tall the host panel is. `heightProp` overrides the
  // measured container height — useful for callers that explicitly want a
  // fixed-height bar chart (e.g. embedded in a fixed sidebar).
  const [size, setSize] = useState<{ w: number; h: number }>({ w: 640, h: heightProp ?? 240 });

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const seed = el.getBoundingClientRect();
    if (seed.width > 0 || seed.height > 0) {
      setSize({
        w: seed.width > 0 ? seed.width : 640,
        h: heightProp ?? (seed.height > 0 ? seed.height : 240),
      });
    }
    const ro = new ResizeObserver((entries) => {
      for (const e of entries) {
        const w = e.contentRect.width;
        const h = e.contentRect.height;
        if (w > 0 || h > 0) {
          setSize((prev) => ({
            w: w > 0 ? w : prev.w,
            h: heightProp ?? (h > 0 ? h : prev.h),
          }));
        }
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [heightProp]);

  const width = size.w;
  const height = size.h;

  const { prepared, overflowCount } = useMemo(
    () => prepareItems(items, thresholds, sortDesc, maxItems),
    [items, thresholds, sortDesc, maxItems],
  );
  // T-206: in horizontal mode, append a non-bar footer row showing the
  // hidden-item count so silently-truncated queries are visually obvious.
  // Vertical mode skips this for now (TODO T-206 vertical).
  const showOverflowRow = orientation === 'horizontal' && overflowCount > 0;

  if (prepared.length === 0) {
    return (
      <div
        style={{
          width: '100%',
          height: heightProp ?? '100%',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          color: VIZ_TOKENS.axis.color,
          fontSize: VIZ_TOKENS.axis.labelFontSize,
          fontStyle: 'italic',
        }}
      >
        No data
      </div>
    );
  }

  // Filter to finite values for the domain calculation. A single NaN (common
  // when the underlying series had no samples in the lookback window) would
  // otherwise propagate through `Math.min`/`Math.max` and turn every scaleX
  // call into NaN, which silently strips every bar from the SVG.
  const values = prepared.map((p) => p.value);
  const finiteValues = values.filter((v) => Number.isFinite(v));
  const rawMin = finiteValues.length > 0 ? Math.min(...finiteValues) : 0;
  const rawMax = finiteValues.length > 0 ? Math.max(...finiteValues) : 0;
  const domainMin = rawMin < 0 ? rawMin : 0;
  const domainMax = rawMax <= 0 ? 0 : rawMax * AXIS_HEADROOM;
  // If all values are zero, pick a tiny positive max so ticks render.
  const effectiveMax = domainMax === domainMin ? domainMin + 1 : domainMax;

  const ticks = niceTicks(domainMin, effectiveMax, 4);
  const axisColor = VIZ_TOKENS.axis.color;
  const gridColor = VIZ_TOKENS.grid.color;
  const labelFont = VIZ_TOKENS.axis.labelFontSize;
  const tickFont = VIZ_TOKENS.axis.tickFontSize;

  if (orientation === 'horizontal') {
    // Label gutter: 30% of width, clamped. Enough for ~24 chars at 11px.
    const labelGutter = Math.max(80, Math.min(width * 0.3, 220));
    const padTop = 12;
    const padBottom = 22; // room for the numeric tick row at the bottom
    const padRight = 56; // room for the value label past the bar end
    const plotX0 = labelGutter;
    const plotX1 = width - padRight;
    const plotW = Math.max(1, plotX1 - plotX0);
    const plotY0 = padTop;
    const plotY1 = height - padBottom;
    const plotH = Math.max(1, plotY1 - plotY0);
    const totalRows = prepared.length + (showOverflowRow ? 1 : 0);
    const band = plotH / totalRows;
    const barH = band * (1 - BAR_BAND_GAP);

    const scaleX = (v: number): number =>
      plotX0 + ((v - domainMin) / (effectiveMax - domainMin)) * plotW;

    return (
      <div ref={containerRef} style={{ width: '100%', height: heightProp ?? '100%' }}>
      <svg
        role="img"
        width={width}
        height={height}
        viewBox={`0 0 ${width} ${height}`}
        style={{ display: 'block' }}
      >
        {/* Gridlines + x tick labels */}
        {ticks.map((t, i) => {
          const x = scaleX(t);
          return (
            <g key={`gx-${i}`}>
              <line
                x1={x}
                x2={x}
                y1={plotY0}
                y2={plotY1}
                stroke={gridColor}
                strokeWidth={VIZ_TOKENS.grid.lineWidth}
              />
              <text
                x={x}
                y={plotY1 + 14}
                fontSize={tickFont}
                fill={axisColor}
                textAnchor="middle"
              >
                {formatValueForDisplay(t, unit)}
              </text>
            </g>
          );
        })}

        {/* Bars + labels */}
        {prepared.map((p, i) => {
          const yCenter = plotY0 + band * (i + 0.5);
          const y = yCenter - barH / 2;
          // NaN entries (no sample in window) keep the row + category label so
          // the user still sees which series was missing, but draw no bar and
          // anchor the value text to the baseline so "—" doesn't fly off-screen.
          const finite = Number.isFinite(p.value);
          const x0 = finite ? scaleX(Math.min(0, p.value)) : plotX0;
          const xv = finite ? scaleX(p.value) : plotX0;
          const w = finite ? Math.max(0, xv - x0) : 0;
          const isHover = hoverIdx === i;
          const labelX = plotX0 - 8;
          const valueX = xv + 6;
          return (
            <g
              key={`bar-${i}`}
              onMouseEnter={() => setHoverIdx(i)}
              onMouseLeave={() => setHoverIdx(null)}
              style={{ cursor: 'default' }}
            >
              <title>
                {`${p.label}: ${formatValueForDisplay(p.value, unit)}`}
              </title>
              {/* Category label (right-aligned in the gutter). */}
              <text
                x={labelX}
                y={yCenter}
                fontSize={labelFont}
                fill={axisColor}
                textAnchor="end"
                dominantBaseline="middle"
              >
                {p.displayLabel}
              </text>
              {/* Invisible hit target so the whole row triggers hover. */}
              <rect
                x={plotX0}
                y={plotY0 + band * i}
                width={plotW + padRight}
                height={band}
                fill="transparent"
              />
              <rect
                x={x0}
                y={y}
                width={w}
                height={barH}
                rx={2}
                ry={2}
                fill={hoverTint(p.fill)}
                fillOpacity={isHover ? 1 : 0.82}
              />
              {showValues && (
                <text
                  x={valueX}
                  y={yCenter}
                  fontSize={labelFont}
                  fill={axisColor}
                  dominantBaseline="middle"
                >
                  {formatValueForDisplay(p.value, unit)}
                </text>
              )}
            </g>
          );
        })}

        {/* T-206: overflow indicator. Sits in the row slot just after the
            last bar; no hover hit-target, no value text — purely an
            "N items hidden" footer so the truncation is never silent. */}
        {showOverflowRow && (() => {
          const overflowYCenter = plotY0 + band * (prepared.length + 0.5);
          return (
            <text
              key="bar-overflow"
              x={plotX0 - 8}
              y={overflowYCenter}
              fontSize={labelFont}
              fill={VIZ_TOKENS.axis.color}
              fillOpacity={0.7}
              fontStyle="italic"
              textAnchor="end"
              dominantBaseline="middle"
            >
              {`\u2026+${overflowCount} more`}
            </text>
          );
        })()}

        {/* Baseline axis (where x = 0 sits inside the plot). */}
        <line
          x1={scaleX(Math.max(domainMin, 0))}
          x2={scaleX(Math.max(domainMin, 0))}
          y1={plotY0}
          y2={plotY1}
          stroke={axisColor}
          strokeOpacity={0.4}
          strokeWidth={1}
        />
      </svg>
      </div>
    );
  }

  // --- Vertical orientation ---
  const rotateLabels = prepared.length > 6;
  const padTop = 12;
  const padLeft = 44; // fits formatted tick labels
  const padRight = 12;
  const padBottom = rotateLabels ? 60 : 36;
  const plotX0 = padLeft;
  const plotX1 = width - padRight;
  const plotW = Math.max(1, plotX1 - plotX0);
  const plotY0 = padTop;
  const plotY1 = height - padBottom;
  const plotH = Math.max(1, plotY1 - plotY0);
  const band = plotW / prepared.length;
  const barW = band * (1 - BAR_BAND_GAP);

  const scaleY = (v: number): number =>
    plotY1 - ((v - domainMin) / (effectiveMax - domainMin)) * plotH;

  // In vertical mode, we shorten the label budget more aggressively when
  // rotation isn't in play (12 chars fits a ~band wide at 11px).
  const verticalBudget = rotateLabels ? LABEL_CHAR_BUDGET : 12;

  return (
    <div ref={containerRef} style={{ width: '100%', height: heightProp ?? '100%' }}>
    <svg
      role="img"
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      style={{ display: 'block' }}
    >
      {/* Gridlines + y tick labels */}
      {ticks.map((t, i) => {
        const y = scaleY(t);
        return (
          <g key={`gy-${i}`}>
            <line
              x1={plotX0}
              x2={plotX1}
              y1={y}
              y2={y}
              stroke={gridColor}
              strokeWidth={VIZ_TOKENS.grid.lineWidth}
            />
            <text
              x={plotX0 - 6}
              y={y}
              fontSize={tickFont}
              fill={axisColor}
              textAnchor="end"
              dominantBaseline="middle"
            >
              {formatValueForDisplay(t, unit)}
            </text>
          </g>
        );
      })}

      {/* Bars + category labels */}
      {prepared.map((p, i) => {
        const xCenter = plotX0 + band * (i + 0.5);
        const x = xCenter - barW / 2;
        // NaN-safe: skip bar geometry but keep the category label so the
        // missing-series gap is still visible.
        const finite = Number.isFinite(p.value);
        const yTop = finite ? scaleY(Math.max(0, p.value)) : plotY1;
        const yBase = finite ? scaleY(Math.min(0, p.value)) : plotY1;
        const h = finite ? Math.max(0, yBase - yTop) : 0;
        const isHover = hoverIdx === i;
        const shortLabel = truncate(p.label, verticalBudget);
        const labelY = plotY1 + (rotateLabels ? 10 : 16);
        return (
          <g
            key={`bar-${i}`}
            onMouseEnter={() => setHoverIdx(i)}
            onMouseLeave={() => setHoverIdx(null)}
            style={{ cursor: 'default' }}
          >
            <title>
              {`${p.label}: ${formatValueForDisplay(p.value, unit)}`}
            </title>
            <rect
              x={plotX0 + band * i}
              y={plotY0}
              width={band}
              height={plotH}
              fill="transparent"
            />
            <rect
              x={x}
              y={yTop}
              width={barW}
              height={h}
              rx={2}
              ry={2}
              fill={hoverTint(p.fill)}
              fillOpacity={isHover ? 1 : 0.82}
            />
            {showValues && h > 0 && (
              <text
                x={xCenter}
                y={yTop - 4}
                fontSize={labelFont}
                fill={axisColor}
                textAnchor="middle"
              >
                {formatValueForDisplay(p.value, unit)}
              </text>
            )}
            <text
              x={xCenter}
              y={labelY}
              fontSize={labelFont}
              fill={axisColor}
              textAnchor={rotateLabels ? 'end' : 'middle'}
              transform={
                rotateLabels ? `rotate(-30 ${xCenter} ${labelY})` : undefined
              }
            >
              {shortLabel}
            </text>
          </g>
        );
      })}

      {/* Zero baseline */}
      <line
        x1={plotX0}
        x2={plotX1}
        y1={scaleY(Math.max(domainMin, 0))}
        y2={scaleY(Math.max(domainMin, 0))}
        stroke={axisColor}
        strokeOpacity={0.4}
        strokeWidth={1}
      />
    </svg>
    </div>
  );
}
