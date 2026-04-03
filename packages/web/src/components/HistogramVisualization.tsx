import React, { useMemo } from 'react';
import {
  ResponsiveContainer,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
} from 'recharts';

interface HistogramBucket {
  le: string;
  count: number;
}

interface Props {
  buckets: HistogramBucket[];
}

function formatValue(v: number): string {
  if (Math.abs(v) >= 1e9) return `${(v / 1e9).toFixed(1)}G`;
  if (Math.abs(v) >= 1e6) return `${(v / 1e6).toFixed(1)}M`;
  if (Math.abs(v) >= 1e3) return `${(v / 1e3).toFixed(1)}K`;
  if (Number.isInteger(v)) return String(v);
  return v.toFixed(2);
}

export default function HistogramVisualization({ buckets }: Props) {
  const data = useMemo(() => {
    if (!buckets.length) return [];

    // Convert cumulative histogram buckets to per-bucket counts
    const sorted = [...buckets].sort((a, b) => {
      const anum = a.le === '+Inf' ? Infinity : parseFloat(a.le);
      const bnum = b.le === '+Inf' ? Infinity : parseFloat(b.le);
      return anum - bnum;
    });

    const results: Array<{ label: string; count: number }> = [];
    let prev = 0;
    for (const b of sorted) {
      if (b.le === '+Inf') continue;
      const delta = Math.max(0, b.count - prev);
      results.push({ label: b.le, count: delta });
      prev = b.count;
    }

    return results;
  }, [buckets]);

  if (data.length === 0) {
    return <div className="text-xs text-[#555570] italic py-4 text-center">No data</div>;
  }

  return (
    <div className="bg-[#141420] rounded-lg p-2">
      <ResponsiveContainer width="100%" height={160}>
        <BarChart data={data} margin={{ top: 0, right: 12, bottom: 4, left: 4 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="#2A2A3E" horizontal />
          <XAxis
            dataKey="label"
            tick={{ fill: '#8888AA', fontSize: 10 }}
            axisLine={{ stroke: '#2A2A3E' }}
            tickLine={false}
            interval={data.length > 12 ? Math.floor(data.length / 8) : 0}
          />
          <YAxis
            tickFormatter={formatValue}
            tick={{ fill: '#8888AA', fontSize: 11 }}
            axisLine={{ stroke: '#2A2A3E' }}
            tickLine={false}
            width={45}
          />
          <Tooltip
            cursor={{ fill: 'rgba(99, 102, 241, 0.08)' }}
            content={({ active, payload }) => {
              if (!active || !payload || payload.length === 0) return null;
              const d = payload[0]?.payload as { label: string; count: number };
              return (
                <div className="bg-[#141420] border border-[#2A2A3E] rounded-lg px-3 py-2 shadow-xl text-xs">
                  <div className="text-[#8888AA] mb-0.5">{d.label}</div>
                  <div className="text-[#E8E8ED] font-mono font-semibold">{formatValue(d.count ?? 0)}</div>
                </div>
              );
            }}
          />
          <Bar dataKey="count" radius={[3, 3, 0, 0]} maxBarSize={40} fill="#6366F1" fillOpacity={0.85} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
