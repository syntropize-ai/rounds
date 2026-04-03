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

interface BarItem {
  label: string;
  value: number;
}

interface Props {
  items: BarItem[];
}

function formatBarValue(v: number): string {
  if (Math.abs(v) >= 1e9) return `${(v / 1e9).toFixed(1)}G`;
  if (Math.abs(v) >= 1e6) return `${(v / 1e6).toFixed(1)}M`;
  if (Math.abs(v) >= 1e3) return `${(v / 1e3).toFixed(1)}K`;
  if (Math.abs(v) < 0.01 && v !== 0) return v.toExponential(1);
  if (Number.isInteger(v)) return String(v);
  return v.toFixed(2);
}

function truncateLabel(label: string, maxLen: number = 20): string {
  if (label.length <= maxLen) return label;
  return `${label.slice(0, maxLen - 3)}...`;
}

export default function BarVisualization({ items }: Props) {
  const chartData = useMemo(
    () =>
      items.slice(0, 15).map((item) => ({
        label: truncateLabel(item.label),
        fullLabel: item.label,
        value: item.value,
      })),
    [items]
  );

  if (chartData.length === 0) {
    return (
      <div className="text-xs text-[#555570] italic py-4 text-center bg-[#141420] rounded-lg">
        No data
      </div>
    );
  }

  const chartHeight = Math.max(chartData.length * 32 + 24, 160);

  return (
    <div className="mt-1 bg-[#141420] rounded-lg p-2">
      <ResponsiveContainer width="100%" height={chartHeight}>
        <BarChart
          data={chartData}
          layout="vertical"
          margin={{ top: 4, right: 40, bottom: 4, left: 8 }}
        >
          <CartesianGrid strokeDasharray="3 3" stroke="#2A2A3E" horizontal={false} />
          <XAxis
            type="number"
            tickFormatter={formatBarValue}
            tick={{ fill: '#8888AA', fontSize: 11 }}
            axisLine={{ stroke: '#2A2A3E' }}
            tickLine={false}
          />
          <YAxis
            type="category"
            dataKey="label"
            tick={{ fill: '#8888AA', fontSize: 11 }}
            axisLine={{ stroke: '#2A2A3E' }}
            tickLine={false}
            width={120}
          />
          <Tooltip
            cursor={{ fill: 'rgba(99, 102, 241, 0.08)' }}
            content={({ active, payload }) => {
              if (!active || !payload || payload.length === 0) return null;
              const data = payload[0]?.payload;
              return (
                <div className="bg-[#141420] border border-[#2A2A3E] rounded-lg px-3 py-2 shadow-lg text-xs">
                  <div className="text-[#E8E8ED] mb-1 max-w-[200px] break-words">{data.fullLabel}</div>
                  <div className="text-[#E8E8ED] font-mono font-semibold">{formatBarValue(data.value ?? 0)}</div>
                </div>
              );
            }}
          />
          <Bar dataKey="value" radius={[0, 4, 4, 0]} maxBarSize={24} fill="#6366F1" fillOpacity={0.85} />
        </BarChart>
      </ResponsiveContainer>
      {items.length > 15 && (
        <p className="text-xs text-[#555570] mt-1 px-2 pb-1">+{items.length - 15} more</p>
      )}
    </div>
  );
}
