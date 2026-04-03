import { useMemo } from 'react'
import { Panel } from '@/api/dashboards'
import { useTimeRange } from '@/stores/timeRange'
import { usePanelData } from '@/hooks/usePanelData'
import { LineChart } from '@/components/charts/LineChart'
import { BarChart } from '@/components/charts/BarChart'
import { StatPanel } from '@/components/charts/StatPanel'
import { GaugePanel } from '@/components/charts/GaugePanel'

interface DashboardGridProps {
  panels: Panel[]
}

// ── PanelContent ──────────────────────────────────────────────────────────────

function PanelContent({ panel }: { panel: Panel }) {
  const { preset } = useTimeRange()
  const { data, loading, error } = usePanelData(panel, preset)

  const chartH = Math.max(100, panel.height * 72 - 56) // subtract header height
  const hasQueries = panel.queries.some((q) => q.expr && q.expr.trim())

  // Panels with no queries show a placeholder
  if (!hasQueries) {
    return (
      <div className="flex-1 flex items-center justify-center text-on-surface-variant/40 text-xs">
        No query configured
      </div>
    )
  }

  if (error) {
    return (
      <div className="flex-1 flex items-center justify-center text-on-surface-variant/50 text-xs px-2 text-center">
        {error}
      </div>
    )
  }

  switch (panel.visualization) {
    case 'stat':
      return (
        <StatPanel
          values={data?.stats ?? []}
          unit={panel.unit}
          loading={loading}
        />
      )

    case 'gauge':
      return (
        <GaugePanel
          values={data?.stats ?? []}
          unit={panel.unit}
          loading={loading}
        />
      )

    case 'time_series':
      return (
        <div className="flex-1 min-h-[100px]">
          <LineChart
            series={data?.series ?? []}
            height={chartH}
            unit={unitSuffix(panel.unit)}
            loading={loading}
          />
        </div>
      )

    case 'bar':
      return (
        <div className="flex-1 min-h-[100px]">
          <BarChart
            data={seriesToBarData(data?.series)}
            height={chartH}
            unit={unitSuffix(panel.unit)}
            loading={loading}
          />
        </div>
      )

    case 'histogram':
      return (
        <div className="flex-1 min-h-[100px]">
          <BarChart
            data={seriesToBarData(data?.series)}
            height={chartH}
            color="#c180ff"
            unit={unitSuffix(panel.unit)}
            loading={loading}
          />
        </div>
      )

    case 'pie':
      return (
        <div className="flex-1 min-h-[100px]">
          <BarChart
            data={seriesToBarData(data?.series)}
            height={chartH}
            color="#62fae3"
            unit={unitSuffix(panel.unit)}
            loading={loading}
          />
        </div>
      )

    case 'heatmap':
      return (
        <div className="flex-1 min-h-[100px]">
          <LineChart
            series={data?.series ?? []}
            height={chartH}
            unit={unitSuffix(panel.unit)}
            loading={loading}
          />
        </div>
      )

    case 'table':
      return (
        <div className="flex-1 overflow-auto min-h-[80px]">
          {loading ? (
            <div className="flex items-center justify-center h-20">
              <span className="w-5 h-5 border-2 border-primary/30 border-t-primary rounded-full animate-spin" />
            </div>
          ) : data?.table ? (
            <DataTable columns={data.table.columns} rows={data.table.rows} />
          ) : (
            <div className="flex items-center justify-center h-20 text-on-surface-variant/50 text-xs">
              No data
            </div>
          )}
        </div>
      )

    case 'status_timeline':
      return (
        <div className="flex-1 min-h-[48px]">
          {loading ? (
            <div className="flex items-center justify-center h-12">
              <span className="w-5 h-5 border-2 border-primary/30 border-t-primary rounded-full animate-spin" />
            </div>
          ) : data?.status && data.status.length > 0 ? (
            <StatusTimeline rows={data.status} />
          ) : (
            <div className="flex items-center justify-center h-12 text-on-surface-variant/50 text-xs">
              No data
            </div>
          )}
        </div>
      )

    default:
      return (
        <div className="flex-1 min-h-[100px]">
          <LineChart
            series={data?.series ?? []}
            height={chartH}
            unit={unitSuffix(panel.unit)}
            loading={loading}
          />
        </div>
      )
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function unitSuffix(unit?: string): string {
  const map: Record<string, string> = {
    bytes: 'B',
    'bytes/s': 'B/s',
    seconds: 's',
    ms: 'ms',
    percentunit: '%',
    percent: '%',
    reqps: 'req/s',
    short: '',
    none: '',
  }
  return unit ? (map[unit] ?? unit) : ''
}

function seriesToBarData(
  series?: { name: string; points: { time: number; value: number }[] }[],
): { label: string; value: number }[] {
  if (!series || series.length === 0) return []
  // For bar/histogram: use the first series, treat each point as a bar.
  // If the series has many points (time range data), take the last value per series.
  if (series.length === 1 && series[0].points.length > 1) {
    // Single series with many time points: show last value labeled by series name
    const last = series[0].points[series[0].points.length - 1]
    return [{ label: series[0].name, value: last?.value ?? 0 }]
  }
  // Multiple series: each series becomes one bar showing its last value
  return series.map((s) => {
    const last = s.points[s.points.length - 1]
    return { label: s.name, value: last?.value ?? 0 }
  })
}

// ── Sub-components ────────────────────────────────────────────────────────────

function DataTable({
  columns,
  rows,
}: {
  columns: string[]
  rows: (string | number)[][]
}) {
  return (
    <table className="w-full text-xs">
      <thead>
        <tr className="border-b border-surface-highest">
          {columns.map((c) => (
            <th
              key={c}
              className="text-left py-1 px-2 text-on-surface-variant font-medium truncate max-w-[120px]"
            >
              {c}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((row, ri) => (
          <tr
            key={ri}
            className="border-b border-surface-highest/50 hover:bg-surface-highest/30 transition-colors"
          >
            {row.map((cell, ci) => (
              <td key={ci} className="py-1 px-2 text-on-surface tabular-nums">
                {typeof cell === 'number' ? cell.toFixed(4).replace(/\.?0+$/, '') : cell}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  )
}

function StatusTimeline({
  rows,
}: {
  rows: { label: string; segments: ('ok' | 'warn' | 'error')[] }[]
}) {
  const colorMap: Record<string, string> = {
    ok: 'bg-secondary/80',
    warn: 'bg-[#ffd166]/80',
    error: 'bg-error/80',
  }
  return (
    <div className="flex flex-col gap-1.5">
      {rows.map((row) => (
        <div key={row.label} className="flex items-center gap-2">
          <span className="text-xs text-on-surface-variant w-20 truncate flex-shrink-0">
            {row.label}
          </span>
          <div className="flex gap-0.5 flex-1">
            {row.segments.map((seg, i) => (
              <div key={i} className={`flex-1 h-4 rounded-sm ${colorMap[seg]}`} />
            ))}
          </div>
        </div>
      ))}
    </div>
  )
}

// ── PanelCard ─────────────────────────────────────────────────────────────────

function PanelCard({ panel }: { panel: Panel }) {
  const heightPx = Math.max(120, panel.height * 72)
  return (
    <div
      className="bg-surface-high rounded-xl border border-surface-highest/60 flex flex-col overflow-hidden"
      style={{ height: heightPx }}
    >
      {/* Header */}
      <div className="flex items-start justify-between px-3 pt-3 pb-1 flex-shrink-0">
        <div className="flex-1 min-w-0">
          <h3
            className="text-xs font-semibold text-on-surface leading-tight truncate"
            title={panel.title}
          >
            {panel.title}
          </h3>
          {panel.description && (
            <p className="text-[10px] text-on-surface-variant/60 leading-tight mt-0.5 truncate">
              {panel.description}
            </p>
          )}
        </div>
        <span className="text-[10px] text-on-surface-variant/40 font-mono ml-2 flex-shrink-0 capitalize">
          {panel.visualization.replace('_', ' ')}
        </span>
      </div>

      {/* Content */}
      <div className="flex-1 flex flex-col px-2 pb-2 min-h-0">
        <PanelContent panel={panel} />
      </div>
    </div>
  )
}

// ── DashboardGrid ─────────────────────────────────────────────────────────────

export function DashboardGrid({ panels }: DashboardGridProps) {
  const sections = useMemo(() => {
    const map = new Map<string, { label: string; panels: Panel[] }>()
    for (const p of panels) {
      const key = p.sectionId ?? '__default__'
      if (!map.has(key)) map.set(key, { label: p.sectionLabel ?? '', panels: [] })
      map.get(key)!.panels.push(p)
    }
    return [...map.values()]
  }, [panels])

  if (panels.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center text-on-surface-variant text-sm">
        No panels yet. Ask the AI to build your dashboard.
      </div>
    )
  }

  return (
    <div className="flex-1 overflow-y-auto p-6 flex flex-col gap-6">
      {sections.map((section, si) => (
        <div key={si} className="flex flex-col gap-3">
          {section.label && (
            <div className="flex items-center gap-3">
              <span className="text-xs font-semibold text-on-surface-variant uppercase tracking-widest">
                {section.label}
              </span>
              <div className="flex-1 h-px bg-surface-highest" />
            </div>
          )}
          <div className="grid grid-cols-12 gap-3">
            {section.panels.map((panel) => (
              <div
                key={panel.id}
                style={{ gridColumn: `span ${Math.min(panel.width, 12)}` }}
              >
                <PanelCard panel={panel} />
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  )
}
