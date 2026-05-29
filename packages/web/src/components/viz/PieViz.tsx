import React, { useMemo, useState } from 'react';
import { formatValueForDisplay } from '../../lib/format/index.js';
import { getSeriesColor } from '../../lib/theme/index.js';

/**
 * A single wedge in the pie. `color` is optional — when omitted the component
 * assigns a stable color per label via the series-color registry, so the same
 * label always paints the same color across reloads and sibling charts.
 */
export interface PieItem {
  label: string;
  value: number;
  color?: string;
}

/**
 * Props accepted by {@link PieViz}.
 */
export interface PieVizProps {
  items: PieItem[];
  /** Formatter id (see `lib/format/registry.ts`). Optional. */
  unit?: string;
  /** `'donut'` carves out a center hole; `'pie'` is solid. Defaults to `'donut'`. */
  mode?: 'pie' | 'donut';
  /**
   * Top-N cap on visible categories. The remainder — plus any slice
   * contributing less than 1.5% of the total (T-207) — folds into a single
   * gray "Other" slice that always renders last. Default `8`.
   */
  maxSlices?: number;
  /** Legend placement. `'hidden'` removes it. */
  legend?: 'right' | 'bottom' | 'hidden';
  /** Show the raw formatted value in each legend row. */
  showValues?: boolean;
  /** Show the share-of-total percentage in each legend row. */
  showPercents?: boolean;
  /** Overall component height in px. */
  height?: number;
}

const OTHER_LABEL = 'Other';
// T-207: gray-on-surface for the aggregated bucket so it visually recedes
// behind the real categorical colors.
const OTHER_COLOR = 'var(--color-on-surface-variant)';
/** Minimum share-of-total below which a slice folds into "Other" (T-207). */
const SMALL_SLICE_THRESHOLD = 0.015;

interface Slice {
  label: string;
  value: number;
  color: string;
  pct: number;
  startAngle: number;
  endAngle: number;
}

/**
 * Aggregate the caller's items into visible slices, sorted descending.
 *
 * Two T-207 rules fold small / numerous categories into a single "Other"
 * bucket that always renders last:
 *   (a) any slice contributing `< 1.5%` of the total folds into Other;
 *   (b) only the top `maxSlices` categories by value stay visible —
 *       everything past the cap also folds into Other.
 *
 * Non-positive values are dropped (a 0-value slice would be invisible anyway
 * and breaks the start/end-angle math when the total collapses to zero).
 */
function buildSlices(items: PieItem[], maxSlices: number): {
  slices: Slice[];
  total: number;
} {
  const positive = items.filter(
    (i) => Number.isFinite(i.value) && i.value > 0,
  );
  const sorted = [...positive].sort((a, b) => b.value - a.value);

  const total = sorted.reduce((s, i) => s + i.value, 0);
  if (total <= 0) return { slices: [], total: 0 };

  // Rule (a): partition by percent-of-total threshold first.
  const threshold = total * SMALL_SLICE_THRESHOLD;
  const largeEnough: PieItem[] = [];
  let otherSum = 0;
  for (const item of sorted) {
    if (item.value >= threshold) largeEnough.push(item);
    else otherSum += item.value;
  }

  // Rule (b): cap visible categories at maxSlices. Because `sorted` is
  // descending, slicing keeps the biggest; the tail joins "Other".
  const cap = Math.max(1, maxSlices);
  const head = largeEnough.slice(0, cap);
  for (const item of largeEnough.slice(cap)) {
    otherSum += item.value;
  }

  // Other is appended LAST so it reads as the "everything else" footer.
  const working: PieItem[] =
    otherSum > 0 ? [...head, { label: OTHER_LABEL, value: otherSum }] : head;

  let cursor = 0;
  const slices: Slice[] = working.map((item, idx) => {
    const frac = item.value / total;
    const startAngle = cursor;
    const endAngle = cursor + frac * 360;
    cursor = endAngle;
    const color =
      item.color ??
      (item.label === OTHER_LABEL
        ? OTHER_COLOR
        : getSeriesColor(idx));
    return {
      label: item.label,
      value: item.value,
      color,
      pct: frac * 100,
      startAngle,
      endAngle,
    };
  });

  return { slices, total };
}

/**
 * Polar to cartesian around `(cx, cy)`. SVG's y-axis grows downward, so we
 * shift by -90° and negate the sine contribution — that places 0° at the top
 * and sweeps clockwise, matching how people intuitively read a pie chart.
 */
function polar(cx: number, cy: number, r: number, angleDeg: number): [number, number] {
  const rad = ((angleDeg - 90) * Math.PI) / 180;
  return [cx + r * Math.cos(rad), cy + r * Math.sin(rad)];
}

/**
 * SVG path for a ring segment between `startAngle` and `endAngle`, with outer
 * radius `rOuter` and inner radius `rInner`. When `rInner === 0` this
 * collapses to a classic pie wedge (outer arc + two radii + close).
 *
 * For a full circle (≈360°) we emit two half-arcs back-to-back; a single
 * 360° arc is degenerate in SVG (start == end, nothing is drawn).
 */
function arcPath(
  cx: number,
  cy: number,
  rOuter: number,
  rInner: number,
  startAngle: number,
  endAngle: number,
): string {
  const sweep = endAngle - startAngle;
  const isFull = sweep >= 359.999;

  if (isFull) {
    // Two half-arcs form a closed ring / disk without the degenerate case.
    const mid = startAngle + 180;
    if (rInner <= 0) {
      const [ox1, oy1] = polar(cx, cy, rOuter, startAngle);
      const [ox2, oy2] = polar(cx, cy, rOuter, mid);
      return [
        `M ${ox1} ${oy1}`,
        `A ${rOuter} ${rOuter} 0 1 1 ${ox2} ${oy2}`,
        `A ${rOuter} ${rOuter} 0 1 1 ${ox1} ${oy1}`,
        'Z',
      ].join(' ');
    }
    const [ox1, oy1] = polar(cx, cy, rOuter, startAngle);
    const [ox2, oy2] = polar(cx, cy, rOuter, mid);
    const [ix1, iy1] = polar(cx, cy, rInner, startAngle);
    const [ix2, iy2] = polar(cx, cy, rInner, mid);
    return [
      `M ${ox1} ${oy1}`,
      `A ${rOuter} ${rOuter} 0 1 1 ${ox2} ${oy2}`,
      `A ${rOuter} ${rOuter} 0 1 1 ${ox1} ${oy1}`,
      `M ${ix1} ${iy1}`,
      `A ${rInner} ${rInner} 0 1 0 ${ix2} ${iy2}`,
      `A ${rInner} ${rInner} 0 1 0 ${ix1} ${iy1}`,
      'Z',
    ].join(' ');
  }

  const largeArc = sweep > 180 ? 1 : 0;

  const [oxStart, oyStart] = polar(cx, cy, rOuter, startAngle);
  const [oxEnd, oyEnd] = polar(cx, cy, rOuter, endAngle);

  if (rInner <= 0) {
    return [
      `M ${cx} ${cy}`,
      `L ${oxStart} ${oyStart}`,
      `A ${rOuter} ${rOuter} 0 ${largeArc} 1 ${oxEnd} ${oyEnd}`,
      'Z',
    ].join(' ');
  }

  const [ixStart, iyStart] = polar(cx, cy, rInner, startAngle);
  const [ixEnd, iyEnd] = polar(cx, cy, rInner, endAngle);

  return [
    `M ${oxStart} ${oyStart}`,
    `A ${rOuter} ${rOuter} 0 ${largeArc} 1 ${oxEnd} ${oyEnd}`,
    `L ${ixEnd} ${iyEnd}`,
    `A ${rInner} ${rInner} 0 ${largeArc} 0 ${ixStart} ${iyStart}`,
    'Z',
  ].join(' ');
}

/**
 * Donut / pie chart with optional legend.
 *
 * Pure presentation: the parent is responsible for fetching and shaping data.
 * Rendering is inline SVG with no chart dependency, so the component is
 * cheap to embed in dashboard grids and plays well with server-side rendering.
 */
export default function PieViz({
  items,
  unit,
  mode = 'donut',
  maxSlices = 8,
  legend = 'right',
  showValues = true,
  showPercents = true,
  height = 220,
}: PieVizProps) {
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);

  const { slices, total } = useMemo(
    () => buildSlices(items, Math.max(1, maxSlices)),
    [items, maxSlices],
  );

  if (slices.length === 0) {
    return (
      <div
        className="flex items-center justify-center text-xs italic text-[var(--color-on-surface-variant)]"
        style={{ height }}
      >
        No data
      </div>
    );
  }

  // Chart area is square (side = height). Legend gets the remaining width.
  const side = height;
  const cx = side / 2;
  const cy = side / 2;
  // Leave ~4px of breathing room so the hover grow-out animation doesn't clip.
  const baseOuter = side / 2 - 6;
  const innerRadius = mode === 'donut' ? baseOuter * 0.58 : 0;

  const totalText = formatValueForDisplay(total, unit);

  const isRow = legend === 'right';
  const isBottom = legend === 'bottom';
  const isHidden = legend === 'hidden';

  // Each slice is drawn at outerRadius = baseOuter, growing by 4px on hover.
  const renderSlice = (s: Slice, i: number) => {
    const isHover = hoverIdx === i;
    const isDimmed = hoverIdx !== null && !isHover;
    const rOuter = isHover ? baseOuter + 4 : baseOuter;
    const d = arcPath(cx, cy, rOuter, innerRadius, s.startAngle, s.endAngle);
    const titleText = `${s.label} — ${formatValueForDisplay(s.value, unit)} (${s.pct.toFixed(1)}%)`;
    return (
      <path
        key={`${s.label}-${i}`}
        d={d}
        fill={s.color}
        stroke="var(--color-surface-container)"
        strokeWidth={2}
        strokeLinejoin="round"
        style={{
          opacity: isDimmed ? 0.45 : 1,
          transition: 'opacity 120ms ease, d 120ms ease',
          cursor: 'pointer',
        }}
        onMouseEnter={() => setHoverIdx(i)}
        onMouseLeave={() => setHoverIdx(null)}
      >
        <title>{titleText}</title>
      </path>
    );
  };

  const chart = (
    <div
      className="relative shrink-0"
      style={{ width: side, height: side }}
    >
      <svg
        width={side}
        height={side}
        viewBox={`0 0 ${side} ${side}`}
        role="img"
        aria-label="Pie chart"
      >
        {slices.map(renderSlice)}
      </svg>
      {mode === 'donut' && (
        <div
          className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center"
        >
          <div
            className="font-[Manrope] font-semibold tabular-nums text-[var(--color-on-surface)]"
            style={{ fontSize: Math.max(14, side * 0.13) }}
          >
            {totalText}
          </div>
          <div className="mt-0.5 text-[0.65rem] uppercase tracking-wide text-[var(--color-on-surface-variant)]">
            Total
          </div>
        </div>
      )}
    </div>
  );

  if (isHidden) {
    return (
      <div
        className="flex items-center justify-center"
        style={{ height }}
      >
        {chart}
      </div>
    );
  }

  const legendRows = slices.map((s, i) => {
    const isHover = hoverIdx === i;
    return (
      <div
        key={`${s.label}-${i}`}
        className="flex min-w-0 items-center gap-2 rounded px-1.5 py-0.5 text-[11px] text-[var(--color-on-surface-variant)]"
        style={{
          backgroundColor: isHover
            ? 'var(--color-surface-high)'
            : 'transparent',
          transition: 'background-color 120ms ease',
          cursor: 'default',
        }}
        onMouseEnter={() => setHoverIdx(i)}
        onMouseLeave={() => setHoverIdx(null)}
      >
        <span
          aria-hidden="true"
          className="h-2.5 w-2.5 shrink-0 rounded-[3px]"
          style={{ backgroundColor: s.color }}
        />
        <span
          className="min-w-0 flex-1 truncate text-[var(--color-on-surface)]"
          title={s.label}
        >
          {s.label}
        </span>
        {showValues && (
          <span className="shrink-0 tabular-nums text-[var(--color-on-surface-variant)]">
            {formatValueForDisplay(s.value, unit)}
          </span>
        )}
        {showPercents && (
          <span className="shrink-0 tabular-nums text-[var(--color-on-surface-variant)]">
            {s.pct.toFixed(1)}%
          </span>
        )}
      </div>
    );
  });

  if (isBottom) {
    return (
      <div
        className="flex w-full flex-col items-center gap-2"
        style={{ height }}
      >
        {chart}
        <div className="flex w-full flex-wrap items-center justify-center gap-x-3 gap-y-1 overflow-hidden">
          {legendRows}
        </div>
      </div>
    );
  }

  // Default: legend on the right.
  return (
    <div
      className="flex w-full items-center gap-3"
      style={{ height }}
    >
      {chart}
      <div className="flex min-w-0 flex-1 flex-col gap-0.5 overflow-y-auto pr-1">
        {legendRows}
      </div>
    </div>
  );
}
