import React, { useMemo, useState, useCallback, useRef } from 'react';
import {
  ResponsiveContainer,
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ReferenceDot,
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
  A: ['#22c55e', '#3b82f6', '#a855f7', '#ef4444', '#eab308', '#22d3ee', '#f472b6', '#fb923c'],
  B: ['#3b82f6', '#22c55e', '#eab308', '#a855f7', '#ef4444', '#34d399', '#f97316', '#38bdf8'],
  C: ['#a855f7', '#ef4444', '#22c55e', '#3b82f6', '#eab308', '#f472b6', '#22d3ee', '#fb923c'],
  D: ['#eab308', '#fb923c', '#ef4444', '#a855f7', '#3b82f6', '#22c55e', '#22d3ee', '#f472b6'],
};

const COLORS = ['#22c55e', '#3b82f6', '#a855f7', '#ef4444', '#eab308', '#22d3ee', '#f472b6', '#fb923c', '#34d399', '#a3a6ff'];

function formatValue(v: number): string {
  if (Number.isNaN(v)) return 'NaN';
  const abs = Math.abs(v);
  if (abs >= 1e9) return `${(v / 1e9).toFixed(1)}G`;
  if (abs >= 1e6) return `${(v / 1e6).toFixed(1)}M`;
  if (abs >= 1e3) return `${(v / 1e3).toFixed(1)}K`;
  if (abs > 0 && abs < 1e-6) return `${(v * 1e9).toFixed(1)}n`;
  if (abs >= 1e-6 && abs < 1e-3) return `${(v * 1e6).toFixed(1)}u`;
  if (abs >= 1e-3 && abs < 1) return `${(v * 1e3).toFixed(1)}m`;
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
  // Show at most 3 label values, prefer shorter values (likely more meaningful like route, method vs long instance strings)
  const sorted = entries.sort((a, b) => a[1].length - b[1].length);
  return sorted.slice(0, 3).map(([, v]) => v).join(' / ');
}

/** Pick the most distinguishing labels across multiple series (labels that differ between series) */
function distinguishingLabels(allSeries: Array<{ labels: Record<string, string> }>): string[] {
  if (allSeries.length <= 1) return [];
  const allKeys = new Set<string>();
  for (const s of allSeries) for (const k of Object.keys(s.labels)) if (k !== '__name__') allKeys.add(k);

  // A label is distinguishing if its values differ across series
  const distinguishing: string[] = [];
  for (const key of allKeys) {
    const values = new Set(allSeries.map((s) => s.labels[key] ?? ''));
    if (values.size > 1) distinguishing.push(key);
  }
  return distinguishing;
}

function smartLabel(s: { labels: Record<string, string> }, distLabels: string[]): string {
  if (distLabels.length > 0) {
    const parts = distLabels.slice(0, 3).map((k) => s.labels[k]).filter(Boolean);
    if (parts.length > 0) return parts.join(' / ');
  }
  return seriesLabel(s.labels);
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
  unit?: string;
}

function formatValueWithUnit(v: number, unit?: string): string {
  if (Number.isNaN(v)) return 'NaN';

  if (unit === 'seconds') {
    const abs = Math.abs(v);
    if (abs > 0 && abs < 1e-6) {
      return `${(v * 1e9).toFixed(1)} ns`;
    }
    if (abs >= 1e-6 && abs < 1e-3) {
      return `${(v * 1e6).toFixed(1)} us`;
    }
    if (abs >= 1e-3 && abs < 1) {
      const ms = v * 1000;
      return `${ms.toFixed(Math.abs(ms) < 10 ? 1 : 0)} ms`;
    }
    return abs < 10 ? `${v.toFixed(3)} s` : `${v.toFixed(2)} s`;
  }

  return formatValue(v);
}

export default function TimeSeriesChart({ result, height = 200, stackMode, unit }: Props) {
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
      return <div className="mt-2 text-xs text-[var(--color-on-surface-variant)] italic">No data</div>;
    }

    const isInstant = allSeries.every((s) => s.points.length === 1);
    if (isInstant) {
      return <InstantTable series={allSeries} totalSeries={totalSeries} unit={unit} />;
    }

    return <RechartsArea series={allSeries} totalSeries={totalSeries} height={height} stackMode={stackMode} unit={unit} />;
  }

  if (!isMetricEvidence(result)) return null;
  const { series, query, totalSeries } = result;

  if (series.length === 0) {
    return <div className="mt-2 px-3 text-xs text-[var(--color-on-surface-variant)] italic break-all">No data returned for <span className="font-mono text-[var(--color-outline)]">{query}</span></div>;
  }

  const isInstant = series.every((s) => s.points.length === 1);
  if (isInstant) {
    return <InstantTable series={series} totalSeries={totalSeries} unit={unit} />;
  }

  return <RechartsArea series={series} totalSeries={totalSeries} height={height} stackMode={stackMode} unit={unit} />;
}

function InstantTable({ series, totalSeries, unit }: { series: ExtendedSeriesData[]; totalSeries: number; unit?: string }) {
  return (
    <div className="mt-2 bg-surface-highest rounded-lg p-3 space-y-1">
      {series.slice(0, 10).map((s, i) => (
        <div key={i} className="flex items-center justify-between text-xs gap-2">
          <span className="text-[var(--color-on-surface-variant)] truncate flex-1">{resolveLabel(s)}</span>
          <span className="font-mono font-semibold text-[var(--color-on-surface)]">{formatValueWithUnit(s.points[0]?.value ?? 0, unit)}</span>
        </div>
      ))}
      {totalSeries > 10 && <div className="text-xs text-[var(--color-outline)] mt-1">+{totalSeries - 10} more series</div>}
    </div>
  );
}

function RechartsArea({
  series,
  totalSeries,
  height,
  stackMode,
  unit,
}: {
  series: ExtendedSeriesData[];
  totalSeries: number;
  height: number;
  stackMode?: 'none' | 'normal' | 'percent';
  unit?: string;
}) {
  const maxChartSeries = 20;
  const displaySeries = series.slice(0, maxChartSeries);
  const isStacked = stackMode === 'normal' || stackMode === 'percent';
  const [hiddenSeries, setHiddenSeries] = useState<Set<number>>(new Set());
  const [activeDotInfo, setActiveDotInfo] = useState<{ ts: number; key: string; color: string } | null>(null);

  const handleLegendClick = useCallback((idx: number, e: React.MouseEvent) => {
    setHiddenSeries((prev) => {
      if (e.ctrlKey || e.metaKey) {
        // Ctrl/Cmd+click: toggle single series
        const next = new Set(prev);
        if (next.has(idx)) next.delete(idx);
        else next.add(idx);
        return next;
      }

      const visibleCount = displaySeries.length - prev.size;
      const isCurrentlyVisible = !prev.has(idx);

      if (visibleCount === displaySeries.length) {
        // All visible → isolate clicked (hide all others)
        const next = new Set<number>();
        for (let i = 0; i < displaySeries.length; i++) {
          if (i !== idx) next.add(i);
        }
        return next;
      }

      if (isCurrentlyVisible && visibleCount === 1) {
        // Only this one visible → restore all
        return new Set();
      }

      // Some hidden: toggle this one (show if hidden, hide if visible)
      const next = new Set(prev);
      if (next.has(idx)) next.delete(idx);
      else next.add(idx);
      // If everything would be hidden, restore all
      if (next.size === displaySeries.length) return new Set();
      return next;
    });
  }, [displaySeries]);

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

  const distLabels = useMemo(() => distinguishingLabels(displaySeries), [displaySeries]);
  const seriesLabels = useMemo(() => displaySeries.map((s) => {
    if (s.legendFormat) return s.legendFormat.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, key) => s.labels[key] ?? key);
    return smartLabel(s, distLabels);
  }), [displaySeries, distLabels]);

  return (
    <div className="h-full rounded-lg px-1 pt-1 pb-0 flex flex-col overflow-hidden">
      <div style={{ height: 'calc(100% - 36px)', minHeight: 80 }}>
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={chartData} margin={{ top: 4, right: 8, bottom: 4, left: 0 }} onMouseLeave={() => setActiveDotInfo(null)}>
          {seriesKeys.map((key, i) => (
            <defs key={`grad-${key}`}>
              <linearGradient id={`grad-${key}`} x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor={seriesColors[i]} stopOpacity={isStacked ? 0.6 : 0.4} />
                <stop offset="95%" stopColor={seriesColors[i]} stopOpacity={0} />
              </linearGradient>
            </defs>
          ))}
          <CartesianGrid strokeDasharray="3 3" stroke="var(--color-outline-variant)" strokeOpacity={0.3} />
          <XAxis
            dataKey="ts"
            type="number"
            domain={['dataMin', 'dataMax']}
            tickFormatter={formatTime}
            tick={{ fill: 'var(--color-on-surface-variant)', fontSize: 11 }}
            axisLine={{ stroke: 'var(--color-outline-variant)' }}
            tickLine={false}
          />
          <YAxis
            tickFormatter={stackMode === 'percent' ? (v: number) => `${v.toFixed(0)}%` : (v: number) => formatValueWithUnit(v, unit)}
            tick={{ fill: 'var(--color-on-surface-variant)', fontSize: 11 }}
            axisLine={{ stroke: 'var(--color-outline-variant)' }}
            tickLine={false}
            width={60}
          />
          <Tooltip
            cursor={{ stroke: 'var(--color-on-surface-variant)', strokeWidth: 1, strokeOpacity: 0.4 }}
            isAnimationActive={false}
            allowEscapeViewBox={{ x: true, y: true }}
            offset={16}
            content={({ active, payload, label, coordinate }) => {
              if (!active || !payload || payload.length === 0) return null;
              const valid = payload.filter((e) => e.value != null && !Number.isNaN(e.value as number));
              if (valid.length === 0) return null;

              // Find the series closest to the mouse Y position
              const mouseY = coordinate?.y ?? 0;
              let closest = valid[0]!;
              let minDist = Infinity;
              for (const entry of valid) {
                // Recharts stores the pixel Y in the payload via the chart coordinate system
                // We approximate by comparing values — the entry whose value maps closest to mouseY
                // Since we don't have pixel positions, just pick by value proximity to a rough scale
                const chartHeight = 200;
                const vals = valid.map((e) => e.value as number);
                const maxVal = Math.max(...vals);
                const minVal = Math.min(...vals);
                const range = maxVal - minVal || 1;
                const entryPixelY = chartHeight - ((entry.value as number) - minVal) / range * chartHeight;
                const dist = Math.abs(entryPixelY - mouseY);
                if (dist < minDist) {
                  minDist = dist;
                  closest = entry;
                }
              }

              const idx = Number(closest.dataKey?.toString().replace('s', ''));
              const ts = label as number;
              const dotKey = String(closest.dataKey);
              // Update active dot (only re-render if changed)
              if (!activeDotInfo || activeDotInfo.ts !== ts || activeDotInfo.key !== dotKey) {
                setTimeout(() => setActiveDotInfo({ ts, key: dotKey, color: String(closest.color) }), 0);
              }
              return (
                <div className="bg-[var(--color-surface-highest)] rounded-lg px-3 py-1.5 shadow-xl text-xs" style={{ border: '1px solid var(--color-outline-variant)' }}>
                  <p className="text-[var(--color-on-surface-variant)] mb-1 font-mono text-[10px]">{formatTime(label as number)}</p>
                  <div className="flex items-center gap-2">
                    <span className="w-2 h-2 rounded-full inline-block shrink-0" style={{ backgroundColor: closest.color }} />
                    <span className="text-[var(--color-on-surface)] truncate" style={{ maxWidth: 180 }}>
                      {seriesLabels[idx] ?? String(closest.dataKey)}
                    </span>
                    <span className="text-[var(--color-on-surface)] font-mono font-semibold ml-auto pl-3">
                      {stackMode === 'percent'
                        ? `${(closest.value as number).toFixed(1)}%`
                        : formatValueWithUnit(closest.value as number, unit)}
                    </span>
                  </div>
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
              activeDot={false}
              connectNulls
              hide={hiddenSeries.has(i)}
              {...(isStacked ? { stackId: 'stack' } : {})}
            />
          ))}
          {activeDotInfo && (
            <ReferenceDot
              x={activeDotInfo.ts}
              y={chartData.find((d) => d.ts === activeDotInfo.ts)?.[activeDotInfo.key] as number | undefined}
              r={5}
              fill={activeDotInfo.color}
              stroke="var(--color-surface-highest)"
              strokeWidth={2}
            />
          )}
        </AreaChart>
      </ResponsiveContainer>
      </div>

      <div className="flex flex-wrap gap-x-3 gap-y-0.5 px-2 pt-1 overflow-y-auto" style={{ height: 32, flexShrink: 0 }}>
        {seriesLabels.map((label, i) => (
          <button
            key={i}
            type="button"
            onClick={(e) => handleLegendClick(i, e)}
            className={`flex items-center gap-1.5 text-xs transition-opacity ${
              hiddenSeries.has(i) ? 'opacity-30' : 'text-[var(--color-on-surface-variant)] hover:text-[var(--color-on-surface)]'
            }`}
          >
            <span className="w-2 h-2 rounded-full inline-block shrink-0" style={{ backgroundColor: seriesColors[i] }} />
            <span className="truncate max-w-[200px]">{label}</span>
          </button>
        ))}
        {totalSeries > maxChartSeries && <span className="text-[10px] text-[var(--color-outline)]">+{totalSeries - maxChartSeries} not plotted</span>}
      </div>
    </div>
  );
}
