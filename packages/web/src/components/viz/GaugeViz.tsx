/**
 * GaugeViz — a radial arc gauge with threshold color bands.
 *
 * Original SVG implementation for openobs. The geometry is a 270° sweep
 * centered at the bottom of the SVG: the arc starts at 135° (lower-left),
 * runs clockwise through 180° (left) / 270° (top) / 0° (right) and ends
 * at 45° (lower-right). Angles are stored in the "SVG polar" convention
 * where 0° is +x and angles increase clockwise.
 *
 * Threshold bands render the track as N colored segments (one per
 * threshold step, proportional to its `[value, nextValue]` share of the
 * overall [min, max] range). The value arc is drawn on top in the
 * threshold-resolved color for `value`.
 */

import { useId, useMemo } from 'react';
import type { Threshold } from '../../lib/data/types.js';
import { formatValueForDisplay } from '../../lib/format/index.js';
import { PALETTE, resolveThresholdColor } from '../../lib/theme/index.js';

interface Props {
  value?: number;
  min?: number;
  max?: number;
  unit?: string;
  title?: string;
  thresholds?: Threshold[];
  /** When true, the track behind the value arc is split into colored bands. */
  showThresholdBands?: boolean;
}

// Sweep geometry. Arc opens downward (gap at the bottom).
const START_ANGLE = 135; // lower-left
const SWEEP = 270; // clockwise
const END_ANGLE = START_ANGLE + SWEEP; // 405° == 45°
// Drawing canvas in SVG user units. The viewBox is fixed; the outer <svg>
// scales to fit the rendered height via its `height`/`width` attributes.
const VIEW_W = 200;
const VIEW_H = 150;
const CX = VIEW_W / 2;
const CY = 95; // arc center sits below vertical midpoint so labels fit under
const RADIUS = 72;
const STROKE = 13;
const BAND_STROKE = 13;

/** Degrees → SVG point on a circle of radius `r` centered at (CX, CY). */
function polar(angleDeg: number, r: number): { x: number; y: number } {
  const rad = (angleDeg * Math.PI) / 180;
  return { x: CX + Math.cos(rad) * r, y: CY + Math.sin(rad) * r };
}

/** SVG arc path between two angles along the same radius, drawn clockwise. */
function arcPath(fromDeg: number, toDeg: number, r: number): string {
  const start = polar(fromDeg, r);
  const end = polar(toDeg, r);
  const delta = Math.abs(toDeg - fromDeg);
  const largeArc = delta > 180 ? 1 : 0;
  // sweep flag = 1 means "draw clockwise" in SVG's y-down coords.
  return `M ${start.x.toFixed(2)} ${start.y.toFixed(2)} A ${r} ${r} 0 ${largeArc} 1 ${end.x.toFixed(2)} ${end.y.toFixed(2)}`;
}

/** Clamp a number into [lo, hi]. */
function clamp(n: number, lo: number, hi: number): number {
  if (n < lo) return lo;
  if (n > hi) return hi;
  return n;
}

/** Map a value in [min, max] to an angle in [START_ANGLE, END_ANGLE]. */
function valueToAngle(v: number, min: number, max: number): number {
  if (max <= min) return START_ANGLE;
  const t = clamp((v - min) / (max - min), 0, 1);
  return START_ANGLE + t * SWEEP;
}

/**
 * Default threshold ramp: green below 60%, yellow 60–85%, red above 85%
 * of the [min, max] range.
 */
function defaultThresholds(min: number, max: number): Threshold[] {
  const span = max - min;
  return [
    { value: min, color: PALETTE.green.base },
    { value: min + span * 0.6, color: PALETTE.yellow.base },
    { value: min + span * 0.85, color: PALETTE.red.base },
  ];
}

interface Band {
  fromAngle: number;
  toAngle: number;
  color: string;
  key: string;
}

/**
 * Split the track into contiguous colored bands, one per threshold step.
 * Each band covers `[threshold[i].value, threshold[i+1].value]` clamped to
 * `[min, max]`. Steps entirely outside the visible range are dropped.
 */
function buildBands(
  thresholds: Threshold[],
  min: number,
  max: number,
): Band[] {
  const sorted = [...thresholds].sort((a, b) => a.value - b.value);
  const bands: Band[] = [];
  for (let i = 0; i < sorted.length; i += 1) {
    const step = sorted[i];
    if (!step) continue;
    const nextStep = sorted[i + 1];
    const from = Math.max(step.value, min);
    const to = Math.min(nextStep ? nextStep.value : max, max);
    if (to <= from) continue;
    bands.push({
      fromAngle: valueToAngle(from, min, max),
      toAngle: valueToAngle(to, min, max),
      color: step.color,
      key: `${i}-${step.value}`,
    });
  }
  return bands;
}

export default function GaugeViz({
  value,
  min = 0,
  max = 100,
  unit,
  title,
  thresholds,
  showThresholdBands = true,
}: Props) {
  const uid = useId();
  const rangeValid = max > min;
  const hasValue =
    value !== undefined && value !== null && Number.isFinite(value);

  const effectiveThresholds = useMemo(
    () =>
      thresholds && thresholds.length > 0
        ? thresholds
        : defaultThresholds(min, max),
    [thresholds, min, max],
  );

  const bands = useMemo(
    () =>
      rangeValid && showThresholdBands
        ? buildBands(effectiveThresholds, min, max)
        : [],
    [effectiveThresholds, min, max, rangeValid, showThresholdBands],
  );

  const trackPath = useMemo(
    () => arcPath(START_ANGLE, END_ANGLE, RADIUS),
    [],
  );

  const valueArc = useMemo(() => {
    if (!hasValue || !rangeValid) return null;
    const angle = valueToAngle(value as number, min, max);
    // Skip drawing a near-zero sweep: strokeLinecap="round" would still paint
    // a visible dot at START_ANGLE, which misrepresents an "empty" gauge.
    if (angle - START_ANGLE < 0.5) return null;
    return arcPath(START_ANGLE, angle, RADIUS);
  }, [hasValue, rangeValid, value, min, max]);

  const valueColor = hasValue
    ? resolveThresholdColor(value as number, effectiveThresholds)
    : 'var(--color-on-surface-variant)';

  const displayText =
    hasValue && rangeValid ? formatValueForDisplay(value, unit) : '\u2014';

  // Endpoint label positions: nudge slightly inward so the min/max labels
  // don't collide with the arc stroke.
  const minPt = polar(START_ANGLE, RADIUS - STROKE);
  const maxPt = polar(END_ANGLE, RADIUS - STROKE);

  return (
    <div className="flex h-full w-full flex-col items-center justify-center">
      {title && (
        <div
          className="mb-1 truncate text-xs"
          style={{ color: 'var(--color-on-surface-variant)' }}
        >
          {title}
        </div>
      )}
      <svg
        role="img"
        aria-label={title ?? 'gauge'}
        viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
        preserveAspectRatio="xMidYMid meet"
        className="h-full w-full"
        style={{ maxHeight: '100%', maxWidth: '100%' }}
      >
        {/* Neutral background track */}
        <path
          d={trackPath}
          fill="none"
          stroke="var(--color-outline-variant)"
          strokeOpacity={0.4}
          strokeWidth={STROKE}
          strokeLinecap="round"
        />

        {/* Threshold bands ("colored backplate") — kept subtle so a zero-value
            gauge doesn't look like it's screaming "critical" from the red band.
            The value arc on top is what the eye should follow. */}
        {bands.map((b) => (
          <path
            key={`band-${uid}-${b.key}`}
            d={arcPath(b.fromAngle, b.toAngle, RADIUS)}
            fill="none"
            stroke={b.color}
            strokeOpacity={0.22}
            strokeWidth={BAND_STROKE}
            strokeLinecap="butt"
          />
        ))}

        {/* Value arc on top */}
        {valueArc && (
          <path
            d={valueArc}
            fill="none"
            stroke={valueColor}
            strokeWidth={STROKE}
            strokeLinecap="round"
          />
        )}

        {/* Center value */}
        <text
          x={CX}
          y={CY + 4}
          textAnchor="middle"
          dominantBaseline="middle"
          fill={valueColor}
          fontSize="22"
          fontWeight={700}
          style={{ fontVariantNumeric: 'tabular-nums' }}
        >
          {displayText}
        </text>

        {/* Endpoint min/max labels */}
        {rangeValid && (
          <>
            <text
              x={minPt.x}
              y={minPt.y + 4}
              textAnchor="middle"
              fill="var(--color-on-surface-variant)"
              fontSize="10"
              style={{ fontVariantNumeric: 'tabular-nums' }}
            >
              {formatValueForDisplay(min, unit, 0)}
            </text>
            <text
              x={maxPt.x}
              y={maxPt.y + 4}
              textAnchor="middle"
              fill="var(--color-on-surface-variant)"
              fontSize="10"
              style={{ fontVariantNumeric: 'tabular-nums' }}
            >
              {formatValueForDisplay(max, unit, 0)}
            </text>
          </>
        )}
      </svg>
    </div>
  );
}
