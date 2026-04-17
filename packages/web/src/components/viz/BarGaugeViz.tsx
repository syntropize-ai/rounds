/**
 * BarGaugeViz — horizontal bar gauges for "value vs ceiling" comparisons.
 *
 * Differs from BarViz in one critical way: BarViz scales bars to the LARGEST
 * value among the items (so the biggest item fills the chart, others are
 * proportional to it). BarGaugeViz scales every bar to a SHARED ceiling
 * (`max`) so each bar reads as "this fraction of the cap" — perfect for SLO
 * percentages, capacity %, quota usage, anywhere comparing N items against a
 * known limit.
 *
 * Two modes:
 *  - `'gradient'` (default): one continuous bar per row, color interpolates
 *    along the length using the threshold ramp.
 *  - `'lcd'`: bar split into ~20 fixed segments; each lit segment is solid
 *    threshold-colored, unlit segments are muted. Reads like a stereo VU
 *    meter — visually distinctive, helpful when many bars share similar
 *    values (Grafana ships both modes for this reason).
 */
import React, { useEffect, useRef, useState } from 'react';
import { formatValueForDisplay } from '../../lib/format/index.js';
import {
  PALETTE,
  VIZ_TOKENS,
  resolveThresholdColor,
  type Threshold,
} from '../../lib/theme/index.js';
import type { BarGaugeMode } from '../panel/types.js';

export interface BarGaugeItem {
  label: string;
  value: number;
}

export interface BarGaugeVizProps {
  items: BarGaugeItem[];
  /** Shared ceiling for every row. When omitted, uses the largest item value. */
  max?: number;
  /** Formatter id for the inline value label (e.g. `'percent'`, `'bytes'`). */
  unit?: string;
  thresholds?: Threshold[];
  /** Default `'gradient'`. */
  mode?: BarGaugeMode;
  /** Pixel height override; otherwise tracks container. */
  height?: number;
}

const LABEL_GUTTER_MIN = 80;
const LABEL_GUTTER_MAX = 200;
const LABEL_GUTTER_FRAC = 0.28;
const VALUE_GUTTER = 60;
const ROW_GAP = 6;
const ROW_PAD_TOP = 10;
const ROW_PAD_BOTTOM = 10;
const LCD_SEGMENTS = 20;
const LCD_SEGMENT_GAP = 1;
const TRACK_RADIUS = 3;

function truncate(label: string, max = 28): string {
  if (label.length <= max) return label;
  return `${label.slice(0, max - 1)}\u2026`;
}

export default function BarGaugeViz({
  items,
  max,
  unit,
  thresholds,
  mode = 'gradient',
  height: heightProp,
}: BarGaugeVizProps): React.JSX.Element {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [size, setSize] = useState<{ w: number; h: number }>({
    w: 600,
    h: heightProp ?? 240,
  });

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const seed = el.getBoundingClientRect();
    if (seed.width > 0 || seed.height > 0) {
      setSize({
        w: seed.width > 0 ? seed.width : 600,
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

  if (items.length === 0) {
    return (
      <div
        ref={containerRef}
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

  // Resolve the shared ceiling. Caller-provided max wins; otherwise pick the
  // largest finite value so at least one bar fills the row.
  const finiteValues = items.map((i) => i.value).filter((v) => Number.isFinite(v));
  const fallbackMax = finiteValues.length > 0 ? Math.max(...finiteValues) : 1;
  const ceiling = typeof max === 'number' && max > 0 ? max : fallbackMax || 1;

  const width = size.w;
  const height = size.h;
  const labelGutter = Math.max(
    LABEL_GUTTER_MIN,
    Math.min(width * LABEL_GUTTER_FRAC, LABEL_GUTTER_MAX),
  );
  const trackX0 = labelGutter;
  const trackX1 = width - VALUE_GUTTER;
  const trackW = Math.max(1, trackX1 - trackX0);
  const plotH = Math.max(1, height - ROW_PAD_TOP - ROW_PAD_BOTTOM);
  const rowPitch = plotH / items.length;
  const barH = Math.max(8, rowPitch - ROW_GAP);

  const trackColor = VIZ_TOKENS.grid.color;
  const labelColor = VIZ_TOKENS.axis.color;
  const labelFont = VIZ_TOKENS.axis.labelFontSize;

  return (
    <div ref={containerRef} style={{ width: '100%', height: heightProp ?? '100%' }}>
      <svg
        role="img"
        width={width}
        height={height}
        viewBox={`0 0 ${width} ${height}`}
        style={{ display: 'block' }}
      >
        {items.map((item, i) => {
          const yTop = ROW_PAD_TOP + i * rowPitch + (rowPitch - barH) / 2;
          const yCenter = yTop + barH / 2;
          const finite = Number.isFinite(item.value);
          const ratio = finite ? Math.max(0, Math.min(1, item.value / ceiling)) : 0;
          const filledW = trackW * ratio;
          const fill = finite
            ? resolveThresholdColor(item.value, thresholds, PALETTE.blue.base)
            : trackColor;
          const valueText = finite ? formatValueForDisplay(item.value, unit) : '\u2014';

          return (
            <g key={`bg-${i}`}>
              <title>{`${item.label}: ${valueText}`}</title>

              {/* Category label, right-aligned in the gutter. */}
              <text
                x={trackX0 - 8}
                y={yCenter}
                fontSize={labelFont}
                fill={labelColor}
                textAnchor="end"
                dominantBaseline="middle"
              >
                {truncate(item.label)}
              </text>

              {/* Empty track — visible regardless of value, to communicate the
                  ceiling visually. */}
              <rect
                x={trackX0}
                y={yTop}
                width={trackW}
                height={barH}
                rx={TRACK_RADIUS}
                ry={TRACK_RADIUS}
                fill={trackColor}
                fillOpacity={0.4}
              />

              {/* Filled portion. */}
              {finite && filledW > 0 && (
                mode === 'lcd' ? (
                  <LcdSegments
                    x={trackX0}
                    y={yTop}
                    totalWidth={trackW}
                    height={barH}
                    ratio={ratio}
                    color={fill}
                  />
                ) : (
                  <rect
                    x={trackX0}
                    y={yTop}
                    width={filledW}
                    height={barH}
                    rx={TRACK_RADIUS}
                    ry={TRACK_RADIUS}
                    fill={fill}
                    fillOpacity={0.85}
                  />
                )
              )}

              {/* Value label after the track. */}
              <text
                x={trackX1 + 6}
                y={yCenter}
                fontSize={labelFont}
                fill={labelColor}
                dominantBaseline="middle"
                style={{ fontVariantNumeric: 'tabular-nums' }}
              >
                {valueText}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}

interface LcdSegmentsProps {
  x: number;
  y: number;
  totalWidth: number;
  height: number;
  ratio: number;
  color: string;
}

function LcdSegments({
  x,
  y,
  totalWidth,
  height,
  ratio,
  color,
}: LcdSegmentsProps): React.JSX.Element {
  const segPitch = totalWidth / LCD_SEGMENTS;
  const segW = Math.max(1, segPitch - LCD_SEGMENT_GAP);
  const litCount = Math.round(LCD_SEGMENTS * ratio);
  const segs: React.ReactNode[] = [];
  for (let i = 0; i < LCD_SEGMENTS; i++) {
    const lit = i < litCount;
    segs.push(
      <rect
        key={`lcd-${i}`}
        x={x + i * segPitch}
        y={y}
        width={segW}
        height={height}
        rx={1}
        ry={1}
        fill={lit ? color : 'transparent'}
        fillOpacity={lit ? 0.85 : 0}
        // Unlit segment: a faint 1px outline in outline-variant so the LCD
        // "empty cell" grid reads on any theme. On dark this lands near the
        // previous rgba(255,255,255,0.05); on light it becomes a pale neutral
        // line instead of invisible white-on-white.
        stroke={lit ? color : 'var(--color-outline-variant)'}
        strokeOpacity={lit ? 0 : 0.6}
        strokeWidth={1}
      />,
    );
  }
  return <>{segs}</>;
}
