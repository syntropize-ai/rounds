import React, { useMemo, useRef, useState, useEffect } from 'react';

interface HeatmapPoint {
  x: number; // timestamp ms
  y: string; // bucket / series label
  value: number;
}

interface Props {
  points: HeatmapPoint[];
}

function interpolateColor(t: number): string {
  // 0 = dark bg, low = cool blue, mid = indigo, high = hot cyan/white
  if (t <= 0) return '#1C1C2E';
  if (t < 0.25) {
    const s = t / 0.25;
    return `rgb(${Math.round(20 + s * 30)}, ${Math.round(20 + s * 60)}, ${Math.round(40 + s * 100)})`;
  }
  if (t < 0.5) {
    const s = (t - 0.25) / 0.25;
    return `rgb(${Math.round(50 + s * 30)}, ${Math.round(80 + s * 60)}, ${Math.round(140 + s * 40)})`;
  }
  if (t < 0.75) {
    const s = (t - 0.5) / 0.25;
    return `rgb(${Math.round(80 + s * 20)}, ${Math.round(140 + s * 60)}, ${Math.round(180 + s * 30)})`;
  }
  const s = (t - 0.75) / 0.25;
  return `rgb(${Math.round(100 + s * 155)}, ${Math.round(200 + s * 40)}, ${Math.round(230 + s * 25)})`;
}

function formatTime(ts: number): string {
  const d = new Date(ts);
  return `${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}`;
}

function formatValue(v: number): string {
  if (Math.abs(v) >= 1e9) return `${(v / 1e9).toFixed(1)}G`;
  if (Math.abs(v) >= 1e6) return `${(v / 1e6).toFixed(1)}M`;
  if (Number.isInteger(v)) return String(v);
  return v.toFixed(2);
}

export default function HeatmapVisualization({ points }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [containerWidth, setContainerWidth] = useState(500);

  useEffect(() => {
    if (!containerRef.current) return;

    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        setContainerWidth(entry.contentRect.width);
      }
    });

    observer.observe(containerRef.current);
    return () => observer.disconnect();
  }, []);

  const { grid, xLabels, yLabels, maxVal } = useMemo(() => {
    if (!points.length) return { grid: [] as number[][], xLabels: [] as number[], yLabels: [] as string[], maxVal: 0 };

    const xs = [...new Set(points.map((p) => p.x))].sort((a, b) => a - b);
    const ys = [...new Set(points.map((p) => p.y))].sort((a, b) => {
      const ap = parseFloat(a);
      const bp = parseFloat(b);
      if (!Number.isNaN(ap) && !Number.isNaN(bp)) return ap - bp;
      return a.localeCompare(b);
    });

    const lookup = new Map<string, number>();
    for (const p of points) {
      const key = `${p.x}|${p.y}`;
      lookup.set(key, p.value ?? 0);
    }

    const grid: number[][] = [];
    for (let yi = 0; yi < ys.length; yi++) {
      const row: number[] = [];
      for (let xi = 0; xi < xs.length; xi++) {
        row.push(lookup.get(`${xs[xi]}|${ys[yi]}`) ?? 0);
      }
      grid.push(row);
    }

    return { grid, xLabels: xs, yLabels: ys, maxVal: Math.max(0, ...points.map((p) => p.value)) };
  }, [points]);

  const [tooltip, setTooltip] = useState<{ x: number; y: number; text: string } | null>(null);

  if (points.length === 0 || grid.length === 0) {
    return <div className="text-xs text-[#555570] italic py-4 text-center">No data</div>;
  }

  const marginLeft = Math.min(80, Math.max(50, yLabels.reduce((m, l) => Math.max(m, l.length * 6), 0) + 8));
  const marginBottom = 22;
  const marginRight = 8;
  const marginTop = 8;

  const chartWidth = containerWidth - marginLeft - marginRight;
  const cellW = Math.max(2, chartWidth / xLabels.length);
  // Scale row height to fill available space, min 12px, max 32px per row
  const availableHeight = Math.max(80, 160 - marginBottom - marginTop);
  const cellH = Math.max(12, Math.min(32, availableHeight / yLabels.length));
  const svgW = containerWidth;
  const svgH = marginTop + yLabels.length * cellH + marginBottom;

  return (
    <div ref={containerRef} className="bg-[#141420] rounded-lg p-2 relative">
      <svg width={svgW} height={svgH} className="block">
        {yLabels.map((label, yi) => (
          <text
            key={yi}
            x={marginLeft - 4}
            y={marginTop + yi * cellH + cellH / 2 + 4}
            textAnchor="end"
            fill="#8888AA"
            fontSize={Math.min(11, cellH - 2)}
          >
            {label.length > 10 ? `${label.slice(0, 10)}...` : label}
          </text>
        ))}

        {grid.map((row, yi) =>
          row.map((val, xi) => (
            <rect
              key={`${yi}-${xi}`}
              x={marginLeft + xi * cellW}
              y={marginTop + yi * cellH}
              width={Math.max(1, cellW - 1)}
              height={Math.max(1, cellH - 1)}
              rx={1}
              fill={interpolateColor(maxVal > 0 ? val / maxVal : 0)}
              className="cursor-crosshair"
              onMouseEnter={(e) => {
                const rect = containerRef.current?.getBoundingClientRect();
                if (!rect) return;
                setTooltip({
                  x: e.clientX - rect.left,
                  y: e.clientY - rect.top - 40,
                  text: `${yLabels[yi]} @ ${formatTime(xLabels[xi] ?? 0)}: ${formatValue(val)}`,
                });
              }}
              onMouseLeave={() => setTooltip(null)}
            />
          ))
        )}

        {(() => {
          const labelCount = Math.min(8, xLabels.length);
          const step = Math.max(1, Math.floor(xLabels.length / labelCount));
          return xLabels
            .filter((_, i) => i % step === 0)
            .map((ts, idx) => {
              const xi = xLabels.indexOf(ts);
              return (
                <text
                  key={ts}
                  x={marginLeft + xi * cellW + cellW / 2}
                  y={marginTop + yLabels.length * cellH + 14}
                  textAnchor="middle"
                  fill="#8888AA"
                  fontSize={10}
                >
                  {formatTime(ts)}
                </text>
              );
            });
        })()}
      </svg>

      {tooltip && (
        <div
          className="absolute pointer-events-none bg-[#1C1C2E] border border-[#2A2A3E] rounded-lg px-2.5 py-1.5 text-[11px] text-[#E8E8ED] shadow-xl z-10 whitespace-nowrap"
          style={{ left: tooltip.x, top: tooltip.y, transform: 'translateX(-50%)' }}
        >
          {tooltip.text}
        </div>
      )}

      <div className="flex items-center gap-1.5 mt-1.5 px-1">
        <span className="text-[10px] text-[#555570]">0</span>
        <div className="flex-1 h-2 rounded-full overflow-hidden flex">
          {Array.from({ length: 20 }, (_, i) => (
            <div key={i} className="flex-1 h-full" style={{ backgroundColor: interpolateColor(i / 19) }} />
          ))}
        </div>
        <span className="text-[10px] text-[#555570]">{formatValue(maxVal)}</span>
      </div>
    </div>
  );
}
