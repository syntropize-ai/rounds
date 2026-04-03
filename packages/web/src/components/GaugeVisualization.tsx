import React, { useMemo } from 'react';

interface Props {
  value?: number;
  max?: number;
  unit?: string;
}

const CX = 100;
const CY = 95;
const R = 75;
const STROKE_WIDTH = 14;
const START_ANGLE = 135;
const SWEEP = 270;

function polarToXY(angleDeg: number, r1: number, r2 = r1): { x: number; y: number } {
  const rad = (angleDeg * Math.PI) / 180;
  return { x: CX + Math.cos(rad) * r1, y: CY + Math.sin(rad) * r2 };
}

function arcPath(fromAngle: number, toAngle: number, r1: number): string {
  const start = polarToXY(fromAngle, r1);
  const end = polarToXY(toAngle, r1);
  const sweep = toAngle - fromAngle;
  const largeArc = sweep > 180 ? 1 : 0;
  return `M ${start.x.toFixed(2)} ${start.y.toFixed(2)} A ${r1} ${r1} 0 ${largeArc} 1 ${end.x.toFixed(2)} ${end.y.toFixed(2)}`;
}

function gaugeColor(pct: number): string {
  if (pct < 0.6) return '#34D399'; // emerald-400
  if (pct < 0.85) return '#F59E0B'; // amber-400
  return '#EF4444'; // red-400
}

function gaugeTrackColor(_pct: number): string {
  return '#2A2A3E';
}

export default function GaugeVisualization({ value, max = 100, unit }: Props) {
  const { bgPath, valuePath, pct, color, trackColor } = useMemo(() => {
    const clampedPct = Math.max(0, Math.min(1, (value ?? 0) / max));
    const valueEndAngle = START_ANGLE + clampedPct * SWEEP;

    return {
      bgPath: arcPath(START_ANGLE, START_ANGLE + SWEEP, R),
      valuePath: clampedPct > 0.005 ? arcPath(START_ANGLE, valueEndAngle, R) : null,
      pct: clampedPct,
      color: gaugeColor(clampedPct),
      trackColor: gaugeTrackColor(clampedPct),
    };
  }, [value, max]);

  const displayValue = Number.isInteger(value) ? String(value) : (value ?? 0).toFixed(1);

  return (
    <div className="flex flex-col items-center justify-center py-3 bg-[#141420] rounded-lg">
      <svg viewBox="0 0 200 140" className="w-48 h-36">
        <defs>
          <linearGradient id={`gauge-grad-${pct.toFixed(2)}`} x1="0%" y1="0%" x2="100%" y2="0%">
            <stop offset="0%" stopColor={color} stopOpacity={1} />
            <stop offset="100%" stopColor={color} stopOpacity={0.7} />
          </linearGradient>
        </defs>

        <path
          d={bgPath}
          fill="none"
          stroke={trackColor}
          strokeWidth={STROKE_WIDTH}
          strokeLinecap="round"
          opacity={0.5}
        />

        {valuePath && (
          <path
            d={valuePath}
            fill="none"
            stroke={`url(#gauge-grad-${pct.toFixed(2)})`}
            strokeWidth={STROKE_WIDTH}
            strokeLinecap="round"
          />
        )}

        <text
          x={CX}
          y={CY - 2}
          textAnchor="middle"
          dominantBaseline="middle"
          fill="#E8E8ED"
          fontSize="28"
          fontWeight="700"
          fontFamily="ui-monospace, monospace"
        >
          {displayValue}
        </text>

        {unit && (
          <text x={CX} y={CY + 24} textAnchor="middle" fill="#8888AA" fontSize="12">
            {unit}
          </text>
        )}

        <text x="29" y="130" textAnchor="middle" fill="#555570" fontSize="11">
          0
        </text>
        <text x="171" y="130" textAnchor="middle" fill="#555570" fontSize="11">
          {max}
        </text>
      </svg>

      <div className="text-xs text-[#8888AA] font-mono mt-0.5">{(pct * 100).toFixed(0)}%</div>
    </div>
  );
}
