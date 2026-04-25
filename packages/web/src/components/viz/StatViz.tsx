import React, { useId, useMemo } from 'react';
import { getFormatter } from '../../lib/format/index.js';
import type { FormattedValue } from '../../lib/format/index.js';
import { resolveThresholdColor, PALETTE } from '../../lib/theme/index.js';
import type { Threshold } from '../../lib/data/types.js';
import { useMeasure } from '../../hooks/useMeasure.js';

/**
 * Aspect ratio breakpoint above which the panel renders the number and
 * sparkline side-by-side (wide layout) instead of stacked. Mirrors
 * Grafana BigValueLayout's 2.5 threshold (BigValueLayout.tsx:534).
 */
const WIDE_LAYOUT_RATIO = 2.5;
/** Below this height (px), the wide layout drops the sparkline. */
const WIDE_SPARKLINE_MIN_HEIGHT = 50;
/** Below this height (px), the stacked layout drops the sparkline. */
const STACKED_SPARKLINE_MIN_HEIGHT = 100;

/**
 * Props accepted by {@link StatViz}.
 *
 * The shape is a superset of the legacy `StatVisualization` props: `value`,
 * `unit`, `title`, and `description` carry identical semantics, so existing
 * call sites can be migrated without changes. The additional props unlock
 * threshold-driven coloring, a background sparkline, and layout tweaks.
 */
export interface StatVizProps {
  /** The numeric sample to display. `undefined` / `NaN` render as an em-dash. */
  value?: number;
  /** Formatter id (see `lib/format/registry.ts`). */
  unit?: string;
  /** Small muted label rendered above the big number. */
  title?: string;
  /** Extra-small muted text rendered below the big number. */
  description?: string;
  /** Decimal override; `undefined` lets the formatter pick a sensible default. */
  decimals?: number;
  /** Threshold steps; the highest whose `value <= sample` drives color. */
  thresholds?: Threshold[];
  /** How to apply the threshold color. Defaults to `'value'`. */
  colorMode?: 'value' | 'background' | 'none';
  /** Faint sparkline rendered behind the number; needs >= 2 points. */
  sparkline?: { timestamps: number[]; values: number[] };
  /** Horizontal alignment of the stack. Defaults to `'center'`. */
  textAlign?: 'center' | 'left';
}

const NO_VALUE = '\u2014'; // em dash

/**
 * Convert a hex color (e.g. `#rrggbb`) to an `rgba(...)` string at `alpha`.
 * Falls back to returning the input untouched if it does not look like a
 * hex color — safe to pass `var(...)` or CSS color names through.
 */
function withAlpha(color: string, alpha: number): string {
  const m = /^#([0-9a-f]{6})$/i.exec(color.trim());
  if (!m || !m[1]) return color;
  const hex = m[1];
  const r = parseInt(hex.slice(0, 2), 16);
  const g = parseInt(hex.slice(2, 4), 16);
  const b = parseInt(hex.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

/**
 * Some formatters (notably `formatShort`) bake the SI suffix letter into the
 * `text` field instead of returning it via `suffix`. To keep the typographic
 * split (huge number, small unit) consistent across all formatters, we peel
 * a trailing SI marker off `text` when `suffix` is empty.
 *
 * Returns the same shape as a `FormattedValue` but guarantees `suffix` carries
 * the unit when one was implicitly present in `text`.
 */
function splitImplicitSuffix(fv: FormattedValue): FormattedValue {
  if (fv.suffix && fv.suffix.length > 0) return fv;
  // Match a trailing single SI letter (K M B T P Q) or a multi-char tail like
  // "Ki" / "Mi" — but only when preceded by a digit so we don't strip the
  // first character of an em-dash placeholder or a stray label.
  const m = /^(.*\d)\s*([KMBTPQ]i?)$/.exec(fv.text);
  if (!m || !m[1] || !m[2]) return fv;
  return { ...fv, text: m[1], suffix: ` ${m[2]}` };
}

interface SparklineGeom {
  /** Polyline points, viewBox `0 0 100 100`. */
  line: string;
  /** Closed polygon for the area fill (line + bottom edge). */
  area: string;
  stroke: string;
}

/**
 * Build SVG geometry for the supplied samples, normalized into the viewBox
 * `0 0 100 100`. Pads the y-domain by 5% so the silhouette never clips
 * against the top/bottom edges. Returns `null` if the data does not contain
 * at least two finite points.
 */
function buildSparkline(
  timestamps: number[],
  values: number[],
  stroke: string,
): SparklineGeom | null {
  const n = Math.min(timestamps.length, values.length);
  if (n < 2) return null;

  let minY = Infinity;
  let maxY = -Infinity;
  const finite: Array<{ t: number; v: number }> = [];
  for (let i = 0; i < n; i++) {
    const t = timestamps[i];
    const v = values[i];
    if (typeof t !== 'number' || typeof v !== 'number') continue;
    if (!Number.isFinite(t) || !Number.isFinite(v)) continue;
    finite.push({ t, v });
    if (v < minY) minY = v;
    if (v > maxY) maxY = v;
  }
  if (finite.length < 2) return null;

  const first = finite[0]!;
  const last = finite[finite.length - 1]!;
  const xSpan = last.t - first.t || 1;

  const pad = (maxY - minY) * 0.05 || Math.abs(maxY) * 0.05 || 1;
  const yLo = minY - pad;
  const yHi = maxY + pad;
  const ySpan = yHi - yLo || 1;

  const pts = finite.map(({ t, v }) => {
    const x = ((t - first.t) / xSpan) * 100;
    // Flip Y so larger values render higher on screen.
    const y = 100 - ((v - yLo) / ySpan) * 100;
    return { x, y, str: `${x.toFixed(2)},${y.toFixed(2)}` };
  });

  const line = pts.map((p) => p.str).join(' ');
  // Close the polygon along the bottom edge so we can fill the area beneath.
  const firstX = pts[0]!.x.toFixed(2);
  const lastX = pts[pts.length - 1]!.x.toFixed(2);
  const area = `${line} ${lastX},100 ${firstX},100`;

  return { line, area, stroke };
}

/**
 * Single-value "big number" panel.
 *
 * Renders `value` through the project's formatter registry, optionally tints
 * the text or background via thresholds, and can layer a ghosted sparkline
 * behind the number for at-a-glance trend context. Pure presentation — the
 * caller is responsible for fetching data and picking thresholds.
 *
 * Typography mimics Grafana stat panels: the number scales with the container
 * width via container queries (clamped between 2rem and 5rem) and any unit
 * suffix renders ~55% size in the muted on-surface-variant color.
 */
export default function StatViz({
  value,
  unit,
  title,
  description,
  decimals,
  thresholds,
  colorMode = 'value',
  sparkline,
  textAlign = 'center',
}: StatVizProps) {
  const hasValue =
    typeof value === 'number' && Number.isFinite(value) && !Number.isNaN(value);

  const formatted = useMemo<FormattedValue>(() => {
    if (!hasValue) return { text: NO_VALUE };
    const fmt = getFormatter(unit);
    return splitImplicitSuffix(fmt(value as number, decimals));
  }, [hasValue, unit, value, decimals]);

  const thresholdColor = hasValue
    ? resolveThresholdColor(
        value as number,
        thresholds,
        'var(--color-on-surface)',
      )
    : 'var(--color-on-surface)';

  // Adaptive coloring (T-205): a near-100% percentage with the default
  // colorMode='value' is almost always a healthy SLO display. Painting the
  // giant number bright green is visually loud for what's just "everything is
  // fine", so we silently swap to a faint background tint and leave the
  // number itself in the regular on-surface color. Only the implicit default
  // triggers this — explicit 'background' or 'none' overrides are honored.
  // DashboardPanelCard converts percentunit to 0–100 before handing the value
  // to StatViz, so we only need to check `unit === 'percent'` here.
  const adaptToBackground =
    hasValue &&
    colorMode === 'value' &&
    unit === 'percent' &&
    (value as number) >= 95;

  const effectiveColorMode: StatVizProps['colorMode'] = adaptToBackground
    ? 'background'
    : colorMode;

  const textColor =
    effectiveColorMode === 'value' && hasValue
      ? thresholdColor
      : 'var(--color-on-surface)';

  // Background mode: a heavily muted wash of the threshold color so the panel
  // reads as "elevated" without overpowering the number itself. The adaptive
  // SLO path uses an even fainter alpha so the tint is barely perceptible.
  const backgroundColor =
    effectiveColorMode === 'background' && hasValue
      ? withAlpha(thresholdColor, adaptToBackground ? 0.06 : 0.1)
      : undefined;

  // Sparkline uses the color of the most recent sample under the current
  // thresholds, falling back to the palette blue when no thresholds apply.
  const sparkGeom = useMemo<SparklineGeom | null>(() => {
    if (!sparkline) return null;
    const { timestamps, values } = sparkline;
    const lastVal = values.length > 0 ? values[values.length - 1] : undefined;
    const stroke =
      typeof lastVal === 'number' && Number.isFinite(lastVal)
        ? resolveThresholdColor(lastVal, thresholds, PALETTE.blue.base)
        : PALETTE.blue.base;
    return buildSparkline(timestamps, values, stroke);
  }, [sparkline, thresholds]);

  const align = textAlign === 'left' ? 'items-start text-left' : 'items-center text-center';
  const justify = textAlign === 'left' ? 'justify-start' : 'justify-center';

  const clipId = useId();

  // Suppress description if it's exactly the title — DashboardPanelCard owns
  // the panel title (and is moving the description to a hover info icon), so
  // duplicating it under the number is just visual noise.
  const showDescription =
    !!description && description.trim().length > 0 && description !== title;

  // Measure the panel's actual pixel size so we can branch the layout on
  // aspect ratio (Grafana BigValueLayout pattern). Pure CSS container
  // queries can size text but can't decide whether to render the sparkline
  // beside the number or stacked behind it — that needs JS.
  const [containerRef, { width: containerW, height: containerH }] = useMeasure<HTMLDivElement>();
  const useWideLayout =
    containerW > 0 && containerH > 0 && containerW / containerH > WIDE_LAYOUT_RATIO;
  const sparklineHeightThreshold = useWideLayout
    ? WIDE_SPARKLINE_MIN_HEIGHT
    : STACKED_SPARKLINE_MIN_HEIGHT;
  // Hide sparkline when the container is too short for it to read well.
  // Until first measurement (containerH === 0) keep it shown so the SSR
  // / first-paint render isn't visibly different from the steady state.
  const showSparkline =
    !!sparkGeom && (containerH === 0 || containerH >= sparklineHeightThreshold);

  // Sparkline SVG is the same in both layouts — only its container changes.
  const sparklineSvg = sparkGeom ? (
    <svg
      aria-hidden="true"
      className="pointer-events-none h-full w-full"
      viewBox="0 0 100 100"
      preserveAspectRatio="none"
    >
      <defs>
        <clipPath id={clipId}>
          <rect x="0" y="0" width="100" height="100" />
        </clipPath>
      </defs>
      <polygon
        points={sparkGeom.area}
        fill={sparkGeom.stroke}
        opacity={0.18}
        clipPath={`url(#${clipId})`}
      />
      <polyline
        points={sparkGeom.line}
        fill="none"
        stroke={sparkGeom.stroke}
        strokeWidth={1.75}
        strokeLinecap="round"
        strokeLinejoin="round"
        vectorEffect="non-scaling-stroke"
        opacity={0.65}
        clipPath={`url(#${clipId})`}
      />
    </svg>
  ) : null;

  // Number block, identical in both layouts.
  const numberBlock = (
    <div
      className={`flex flex-col ${align} ${justify} w-full min-w-0`}
    >
      {title ? (
        <div className="text-xs font-medium uppercase tracking-wide text-on-surface-variant">
          {title}
        </div>
      ) : null}

      <div
        className="font-[Manrope] font-bold tabular-nums leading-none tracking-tight"
        style={{
          // Size to the SMALLER of 20% inline-size or 50% block-size so
          // wide-but-short panels don't overflow vertically. The clamp
          // floors at 2.25rem and caps at 6rem.
          fontSize: 'clamp(2.25rem, min(20cqw, 50cqh), 6rem)',
          color: textColor,
        }}
      >
        {formatted.prefix ? (
          <span
            style={{
              fontSize: '55%',
              fontWeight: 500,
              color: 'var(--color-on-surface-variant)',
              marginRight: '0.15em',
            }}
          >
            {formatted.prefix}
          </span>
        ) : null}
        <span>{formatted.text}</span>
        {formatted.suffix ? (
          <span
            style={{
              fontSize: '55%',
              fontWeight: 500,
              color: 'var(--color-on-surface-variant)',
              marginLeft: '0.05em',
            }}
          >
            {formatted.suffix}
          </span>
        ) : null}
      </div>

      {showDescription ? (
        <div className="mt-1 text-[0.7rem] text-on-surface-variant">
          {description}
        </div>
      ) : null}
    </div>
  );

  // Wide layout: number on the left taking 50% width, sparkline on the right
  // taking the other 50%. Sparkline uses full panel height instead of the
  // bottom 55% of the stacked layout.
  if (useWideLayout && showSparkline) {
    return (
      <div
        ref={containerRef}
        className="relative flex h-full w-full flex-row items-center overflow-hidden px-3 py-2"
        style={{
          ...(backgroundColor ? { backgroundColor } : null),
          containerType: 'size',
        }}
      >
        <div className="flex h-full w-1/2 items-center">{numberBlock}</div>
        <div className="h-full w-1/2 flex items-center">{sparklineSvg}</div>
      </div>
    );
  }

  // Stacked layout (default + narrow panels). Sparkline is rendered behind
  // the number as a faint background fill — same visual as before Stage 2,
  // just gated on container height.
  return (
    <div
      ref={containerRef}
      className={`relative flex h-full w-full flex-col ${align} ${justify} overflow-hidden px-3 py-2`}
      style={{
        ...(backgroundColor ? { backgroundColor } : null),
        containerType: 'size',
      }}
    >
      {showSparkline && (
        <div
          className="pointer-events-none absolute inset-x-0 bottom-0"
          style={{ height: '55%' }}
        >
          {sparklineSvg}
        </div>
      )}
      <div className="relative z-10 w-full">{numberBlock}</div>
    </div>
  );
}
