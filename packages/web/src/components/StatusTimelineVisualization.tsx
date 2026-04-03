import React, { useMemo } from 'react';

interface StatusSpan {
  label: string;
  start: number; // timestamp ms
  end: number;
  status: string; // e.g. "up", "down", "degraded", "ok", "warning", "critical"
}

interface Props {
  spans: StatusSpan[];
}

const STATUS_COLORS: Record<string, string> = {
  up: '#22C55E',
  ok: '#22C55E',
  healthy: '#22C55E',
  success: '#22C55E',
  degraded: '#F59E0B',
  warning: '#F59E0B',
  slow: '#F59E0B',
  down: '#EF4444',
  critical: '#EF4444',
  error: '#EF4444',
  fail: '#EF4444',
  unknown: '#555570',
  maintenance: '#6366F1',
};

function getStatusColor(status: string): string {
  return STATUS_COLORS[status.toLowerCase()] ?? '#555570';
}

function formatTime(ts: number): string {
  const d = new Date(ts);
  return `${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}`;
}

export default function StatusTimelineVisualization({ spans }: Props) {
  const { rows, timeMin, timeMax } = useMemo(() => {
    if (!spans.length) return { rows: [] as Array<{ label: string; spans: StatusSpan[] }>, timeMin: 0, timeMax: 0 };

    const labelMap = new Map<string, StatusSpan[]>();
    let tMin = Infinity;
    let tMax = -Infinity;

    for (const s of spans) {
      if (!labelMap.has(s.label)) labelMap.set(s.label, []);
      labelMap.get(s.label)!.push(s);
      if (s.start < tMin) tMin = s.start;
      if (s.end > tMax) tMax = s.end;
    }

    const result = [...labelMap.entries()].map(([label, spl]) => ({
      label,
      spans: spl.sort((a, b) => a.start - b.start),
    }));

    return { rows: result, timeMin: tMin, timeMax: tMax };
  }, [spans]);

  if (rows.length === 0) {
    return <div className="text-xs text-[#555570] italic py-4 text-center">No data</div>;
  }

  const marginLeft = 80;
  const barHeight = 18;
  const rowGap = 4;
  const marginBottom = 22;
  const chartWidth = 500;
  const svgH = marginBottom + rows.length * (barHeight + rowGap) + 8;
  const duration = timeMax - timeMin || 1;

  return (
    <div className="bg-[#141420] rounded-lg p-2 overflow-x-auto">
      <svg width={Math.max(chartWidth, 560)} height={svgH} className="block">
        {rows.map((row, ri) => {
          const y = ri * (barHeight + rowGap) + 2;
          return (
            <g key={row.label}>
              <text
                x={marginLeft - 8}
                y={y + barHeight / 2 + 4}
                textAnchor="end"
                fill="#8888AA"
                fontSize={11}
              >
                {row.label.length > 10 ? `${row.label.slice(0, 10)}...` : row.label}
              </text>

              <rect
                x={marginLeft}
                y={y}
                width={chartWidth}
                height={barHeight}
                rx={4}
                fill="#1C1C2E"
              />

              {row.spans.map((s, si) => {
                const x = marginLeft + ((s.start - timeMin) / duration) * chartWidth;
                const w = Math.max(2, ((s.end - s.start) / duration) * chartWidth);
                return (
                  <rect
                    key={si}
                    x={x}
                    y={y}
                    width={w}
                    height={barHeight}
                    rx={4}
                    fill={getStatusColor(s.status)}
                    opacity={0.85}
                  >
                    <title>{`${s.label}: ${s.status} (${formatTime(s.start)} - ${formatTime(s.end)})`}</title>
                  </rect>
                );
              })}
            </g>
          );
        })}

        {Array.from({ length: 5 }, (_, i) => {
          const t = timeMin + (i / 4) * duration;
          const x = marginLeft + (i / 4) * chartWidth;
          return (
            <text
              key={i}
              x={x}
              y={svgH - 4}
              textAnchor="middle"
              fill="#8888AA"
              fontSize={10}
            >
              {formatTime(t)}
            </text>
          );
        })}
      </svg>
    </div>
  );
}
