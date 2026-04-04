import React, { useMemo, useState, useCallback } from 'react';
import {
  ResponsiveContainer,
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
} from 'recharts';

interface TimeSeriesPoint {
  ts: number;
  value: number;
}

interface TimeSeriesData {
  labels: Record<string, string>;
  points: TimeSeriesPoint[];
}

interface ExtendedSeriesData extends TimeSeriesData {
  refId?: string;
  legendFormat?: string;
}

interface MetricEvidenceResult {
  query: string;
  series: TimeSeriesData[];
  totalSeries: number;
}

type MultiQueryResult = Array<{
  refId?: string;
  legendFormat?: string;
  series: TimeSeriesData[];
  totalSeries: number;
}>;

function isMetricEvidence(r: unknown): r is MetricEvidenceResult {
  return typeof r === 'object' && r !== null && 'series' in r && Array.isArray((r as MetricEvidenceResult).series);
}

function isMultiQueryResult(r: unknown): r is MultiQueryResult {
  return (
    Array.isArray(r) &&
    r.every(
      (item) =>
        typeof item === 'object' &&
        item !== null &&
        'series' in item &&
        Array.isArray((item as MultiQueryResult[number]).series),
    )
  );
}

const REFID_COLORS: Record<string, string[]> = {
  A: ['#6366f1', '#818cf8', '#a5b4fc', '#c7d2fe'],
  B: ['#22d3ee', '#34d399', '#4ade80', '#86efac'],
  C: ['#f472b6', '#a78bfa', '#e879f9', '#c084fc'],
  D: ['#fbbf24', '#fb923c', '#f97316', '#facc15'],
};

const COLORS = ['#6366f1', '#22d3ee', '#a78bfa', '#f472b6', '#34d399', '#fbbf24', '#fb923c', '#38bdf8', '#c084fc', '#4ade80'];

function formatValue(v: number): string {
  if (Number.isNaN(v)) return 'NaN';
  if (Math.abs(v) >= 1e9) return `${(v / 1e9).toFixed(1)}G`;
  if (Math.abs(v) >= 1e6) return `${(v / 1e6).toFixed(1)}M`;
  if (Math.abs(v) >= 1e3) return `${(v / 1e3).toFixed(1)}K`;
  if (Math.abs(v) < 0.01 && v !== 0) return v.toExponential(1);
  if (Number.isInteger(v)) return String(v);
  return v.toFixed(2);
}

function formatTime(ts: number): string {
  const d = new Date(ts);
  return `${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}`;
}

function seriesLabel(labels: Record<string, string>): string {
  const entries = Object.entries(labels).filter(([k]) => k !== '__name__');
  if (entries.length === 0) return labels.__name__ ?? 'series';
  return entries.slice(0, 3).map(([, v]) => v).join(' / ');
}

function resolveLabel(s: ExtendedSeriesData): string {
  if (s.legendFormat) {
    return s.legendFormat.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, key) => s.labels[key] ?? key);
  }
  return seriesLabel(s.labels);
}

interface Props {
  result: unknown;
  height?: number;
  stackMode?: 'none' | 'normal' | 'percent';
}

export default function TimeSeriesChart({ result, height = 200, stackMode }: Props) {
  if (isMultiQueryResult(result)) {
    const allSeries: ExtendedSeriesData[] = [];
    let totalSeries = 0;
    for (const qr of result) {
      for (const s of qr.series) {
        allSeries.push({ ...s, refId: qr.refId, legendFormat: qr.legendFormat });
      }
      totalSeries += qr.totalSeries;
    }

    if (allSeries.length === 0) {
      return <div className="mt-2 text-xs text-[#8888AA] italic">No data</div>;
    }

    const isInstant = allSeries.every((s) => s.points.length === 1);
    if (isInstant) {
      return <InstantTable series={allSeries} totalSeries={totalSeries} />;
    }

    return <RechartsArea series={allSeries} totalSeries={totalSeries} height={height} stackMode={stackMode} />;
  }

  if (!isMetricEvidence(result)) return null;
  const { series, query, totalSeries } = result;

  if (series.length === 0) {
    return <div className="mt-2 px-3 text-xs text-[#8888AA] italic break-all">No data returned for <span className="font-mono text-[#555570]">{query}</span></div>;
  }

  const isInstant = series.every((s) => s.points.length === 1);
  if (isInstant) {
    return <InstantTable series={series} totalSeries={totalSeries} />;
  }

  return <RechartsArea series={series} totalSeries={totalSeries} height={height} stackMode={stackMode} />;
}

function InstantTable({ series, totalSeries }: { series: ExtendedSeriesData[]; totalSeries: number }) {
  return (
    <div className="mt-2 bg-[#141420] rounded-lg p-3 space-y-1">
      {series.slice(0, 10).map((s, i) => (
        <div key={i} className="flex items-center justify-between text-xs gap-2">
          <span className="text-[#8888AA] truncate flex-1">{resolveLabel(s)}</span>
          <span className="font-mono font-semibold text-[#E8E8ED]">{formatValue(s.points[0]?.value ?? 0)}</span>
        </div>
      ))}
      {totalSeries > 10 && <div className="text-xs text-[#555570] mt-1">+{totalSeries - 10} more series</div>}
    </div>
  );
}

function RechartsArea({
  series,
  totalSeries,
  height,
  stackMode,
}: {
  series: ExtendedSeriesData[];
  totalSeries: number;
  height: number;
  stackMode?: 'none' | 'normal' | 'percent';
}) {
  const displaySeries = series.slice(0, 10);
  const isStacked = stackMode === 'normal' || stackMode === 'percent';
  const [hiddenSeries, setHiddenSeries] = useState<Set<number>>(new Set());

  const toggleSeries = useCallback((idx: number) => {
    setHiddenSeries((prev) => {
      const next = new Set(prev);
      if (next.has(idx)) next.delete(idx);
      else next.add(idx);
      return next;
    });
  }, []);

  const { chartData, seriesKeys } = useMemo(() => {
    const tsMap = new Map<number, Record<string, number>>();
    const keys: string[] = [];

    displaySeries.forEach((s, i) => {
      const key = `s${i}`;
      keys.push(key);
      for (const p of s.points) {
        let row = tsMap.get(p.ts);
        if (!row) {
          row = { ts: p.ts };
          tsMap.set(p.ts, row);
        }
        row[key] = p.value;
      }
    });

    let data = Array.from(tsMap.values()).sort((a, b) => (a.ts ?? 0) - (b.ts ?? 0));

    if (stackMode === 'percent') {
      data = data.map((row) => {
        const total = keys.reduce((sum, k) => sum + (row[k] ?? 0), 0);
        if (!total) return row;
        const normalized = { ...row, ts: row.ts } as Record<string, number>;
        for (const k of keys) normalized[k] = ((row[k] ?? 0) / total) * 100;
        return normalized;
      });
    }

    return { chartData: data, seriesKeys: keys };
  }, [displaySeries, stackMode]);

  const seriesColors = useMemo(() => {
    const refIdCounters: Record<string, number> = {};
    return displaySeries.map((s) => {
      const refId = s.refId ?? 'A';
      const colors = REFID_COLORS[refId] ?? COLORS;
      const idx = refIdCounters[refId] ?? 0;
      refIdCounters[refId] = idx + 1;
      return colors[idx % colors.length];
    });
  }, [displaySeries]);

  const seriesLabels = useMemo(() => displaySeries.map((s) => resolveLabel(s)), [displaySeries]);

  return (
    <div className="flex flex-col h-full bg-[#141420] rounded-lg p-2">
      <div className="flex-1 min-h-0">
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={chartData} margin={{ top: 8, right: 12, bottom: 20, left: 8 }}>
          {seriesKeys.map((key, i) => (
            <defs key={`grad-${key}`}>
              <linearGradient id={`grad-${key}`} x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor={seriesColors[i]} stopOpacity={isStacked ? 0.6 : 0.3} />
                <stop offset="95%" stopColor={seriesColors[i]} stopOpacity={0} />
              </linearGradient>
            </defs>
          ))}
          <CartesianGrid strokeDasharray="3 3" stroke="#2A2A3E" />
          <XAxis
            dataKey="ts"
            type="number"
            domain={['dataMin', 'dataMax']}
            tickFormatter={formatTime}
            tick={{ fill: '#8888AA', fontSize: 11 }}
            axisLine={{ stroke: '#2A2A3E' }}
            tickLine={false}
          />
          <YAxis
            tickFormatter={stackMode === 'percent' ? (v: number) => `${v.toFixed(0)}%` : formatValue}
            tick={{ fill: '#8888AA', fontSize: 11 }}
            axisLine={{ stroke: '#2A2A3E' }}
            tickLine={false}
            width={50}
          />
          <Tooltip
            content={({ active, payload, label }) => {
              if (!active || !payload || payload.length === 0) return null;
              return (
                <div className="bg-[#141420] border border-[#2A2A3E] rounded-lg px-3 py-2 shadow-xl text-xs">
                  <p className="text-[#8888AA] mb-1.5">{formatTime(label as number)}</p>
                  {payload.map((entry, idx) => (
                    <div key={idx} className="flex items-center gap-2">
                      <span className="w-2 h-2 rounded-full inline-block" style={{ backgroundColor: entry.color }} />
                      <span className="text-[#E8E8ED] truncate max-w-[140px]">
                        {seriesLabels[Number(entry.dataKey?.toString().replace('s', ''))] ?? String(entry.dataKey)}
                      </span>
                      <span className="text-[#E8E8ED] font-mono font-semibold ml-auto">
                        {stackMode === 'percent'
                          ? `${(entry.value as number).toFixed(1)}%`
                          : formatValue(entry.value as number)}
                      </span>
                    </div>
                  ))}
                </div>
              );
            }}
          />
          {seriesKeys.map((key, i) => (
            <Area
              key={key}
              type="monotone"
              dataKey={key}
              stroke={seriesColors[i]}
              strokeWidth={2}
              fill={`url(#grad-${key})`}
              dot={false}
              connectNulls
              hide={hiddenSeries.has(i)}
              {...(isStacked ? { stackId: 'stack' } : {})}
            />
          ))}
        </AreaChart>
      </ResponsiveContainer>
      </div>

      <div className="flex flex-wrap gap-x-3 gap-y-1 mt-1 px-2 pb-1 shrink-0">
        {seriesLabels.map((label, i) => (
          <button
            key={i}
            type="button"
            onClick={() => toggleSeries(i)}
            className={`flex items-center gap-1.5 text-xs transition-opacity ${
              hiddenSeries.has(i) ? 'opacity-30' : 'text-[#8888AA] hover:text-[#E8E8ED]'
            }`}
          >
            <span className="w-2 h-2 rounded-full inline-block shrink-0" style={{ backgroundColor: seriesColors[i] }} />
            <span className="truncate max-w-[200px]">{label}</span>
          </button>
        ))}
        {totalSeries > 10 && <span className="text-xs text-[#555570]">+{totalSeries - 10} more</span>}
      </div>
    </div>
  );
}
