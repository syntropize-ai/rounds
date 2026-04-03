import React, { useMemo } from 'react';
import {
  ResponsiveContainer,
  PieChart,
  Pie,
  Cell,
  Tooltip,
} from 'recharts';

interface PieItem {
  label: string;
  value: number;
}

interface Props {
  items: PieItem[];
}

const COLORS = [
  '#6366f1',
  '#22d3ee',
  '#a78bfa',
  '#f472b6',
  '#34d399',
  '#fbbf24',
  '#fb923c',
  '#38bdf8',
  '#c084fc',
  '#4ade80',
];

function formatValue(v: number): string {
  if (Math.abs(v) >= 1e9) return `${(v / 1e9).toFixed(1)}G`;
  if (Math.abs(v) >= 1e6) return `${(v / 1e6).toFixed(1)}M`;
  if (Math.abs(v) >= 1e3) return `${(v / 1e3).toFixed(1)}K`;
  if (Number.isInteger(v)) return String(v);
  return v.toFixed(2);
}

export default function PieVisualization({ items }: Props) {
  const data = useMemo(() => items.slice(0, 12), [items]);
  const total = useMemo(() => data.reduce((s, d) => s + d.value, 0), [data]);

  if (data.length === 0) {
    return <div className="text-xs text-[#555570] italic py-4 text-center">No data</div>;
  }

  return (
    <div className="flex items-center gap-2 bg-[#141420] rounded-lg p-2 h-full">
      <div className="flex-1 min-w-0" style={{ minHeight: 140 }}>
        <ResponsiveContainer width="100%" height={140}>
          <PieChart>
            <Pie
              data={data}
              dataKey="value"
              nameKey="label"
              cx="50%"
              cy="50%"
              innerRadius="45%"
              outerRadius="78%"
              paddingAngle={2}
              strokeWidth={0}
            >
              {data.map((_, i) => (
                <Cell key={i} fill={COLORS[i % COLORS.length]} />
              ))}
            </Pie>
            <Tooltip
              content={({ active, payload }) => {
                if (!active || !payload || payload.length === 0) return null;
                const entry = payload[0]?.payload as PieItem;
                const pct = total > 0 ? `${((entry.value / total) * 100).toFixed(1)}%` : '0%';
                return (
                  <div className="bg-[#141420] border border-[#2A2A3E] rounded-lg px-3 py-2 shadow-xl text-xs">
                    <p className="text-[#E8E8ED] mb-0.5">{entry.label}</p>
                    <div className="text-[#E8E8ED] font-mono font-semibold">
                      {formatValue(entry.value as number)} | {pct}
                    </div>
                  </div>
                );
              }}
            />
          </PieChart>
        </ResponsiveContainer>
      </div>

      <div className="shrink-0 space-y-1 max-h-[140px] overflow-y-auto pr-1">
        {data.map((d, i) => (
          <div key={i} className="flex items-center gap-1.5 text-[11px] text-[#8888AA]">
            <span
              className="w-2 h-2 rounded-full shrink-0"
              style={{ backgroundColor: COLORS[i % COLORS.length] }}
            />
            <span className="truncate max-w-[90px]">{d.label}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
