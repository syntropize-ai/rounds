import {
  ResponsiveContainer,
  LineChart as ReLineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  TooltipProps,
} from 'recharts'

// ── Types ─────────────────────────────────────────────────────────────────────

export interface Series {
  name: string
  color?: string
  points: { time: number; value: number }[] // time is unix ms
}

interface LineChartProps {
  series: Series[]
  height?: number
  unit?: string
  loading?: boolean
}

// ── Constants ─────────────────────────────────────────────────────────────────

const COLORS = ['#a3a6ff', '#62fae3', '#c180ff', '#ff6e84', '#ffd166', '#4ecdc4']

// ── Formatters ────────────────────────────────────────────────────────────────

function formatYValue(v: number, unit?: string): string {
  let num: string
  const abs = Math.abs(v)
  if (abs === 0) {
    num = '0'
  } else if (abs >= 1_000_000_000) {
    num = `${(v / 1_000_000_000).toFixed(1)}G`
  } else if (abs >= 1_000_000) {
    num = `${(v / 1_000_000).toFixed(1)}M`
  } else if (abs >= 1_000) {
    num = `${(v / 1_000).toFixed(1)}k`
  } else if (abs < 0.01 && abs > 0) {
    num = v.toExponential(1)
  } else if (abs < 1) {
    num = v.toFixed(3).replace(/\.?0+$/, '')
  } else {
    num = v.toFixed(1).replace(/\.0$/, '')
  }
  return unit ? `${num}${unit}` : num
}

function formatTime(v: number): string {
  return new Date(v).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

// ── Custom Tooltip ────────────────────────────────────────────────────────────

function CustomTooltip({
  active,
  payload,
  label,
  unit,
}: TooltipProps<number, string> & { unit?: string }) {
  if (!active || !payload || payload.length === 0) return null

  return (
    <div
      style={{
        background: '#1a1919',
        border: '1px solid #2e2e2e',
        borderRadius: 8,
        padding: '6px 10px',
        fontSize: 11,
        maxWidth: 240,
      }}
    >
      <div style={{ color: '#777575', marginBottom: 4 }}>{formatTime(label as number)}</div>
      {payload.map((entry) => (
        <div
          key={entry.name}
          style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 2 }}
        >
          <span
            style={{
              display: 'inline-block',
              width: 8,
              height: 8,
              borderRadius: '50%',
              background: entry.color,
              flexShrink: 0,
            }}
          />
          <span
            style={{
              color: '#adaaaa',
              maxWidth: 140,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {entry.name}
          </span>
          <span style={{ color: '#e8e6e3', fontWeight: 600, marginLeft: 'auto', paddingLeft: 8 }}>
            {formatYValue(entry.value ?? 0, unit)}
          </span>
        </div>
      ))}
    </div>
  )
}

// ── LineChart ─────────────────────────────────────────────────────────────────

export function LineChart({ series, height = 200, unit = '', loading = false }: LineChartProps) {
  if (loading) {
    return (
      <div className="flex items-center justify-center" style={{ height }}>
        <span className="w-5 h-5 border-2 border-primary/30 border-t-primary rounded-full animate-spin" />
      </div>
    )
  }

  if (!series || series.length === 0) {
    return (
      <div
        className="flex items-center justify-center text-on-surface-variant/50 text-xs"
        style={{ height }}
      >
        No data
      </div>
    )
  }

  // Build unified time-indexed chart data
  const timeMap = new Map<number, Record<string, number>>()
  series.forEach((s) => {
    s.points.forEach(({ time, value }) => {
      if (!timeMap.has(time)) timeMap.set(time, { time })
      timeMap.get(time)![s.name] = value
    })
  })
  const chartData = Array.from(timeMap.values()).sort((a, b) => a.time - b.time)

  return (
    <div className="flex flex-col gap-1 h-full">
      <ResponsiveContainer width="100%" height={height}>
        <ReLineChart data={chartData} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="#262626" vertical={false} />
          <XAxis
            dataKey="time"
            type="number"
            domain={['dataMin', 'dataMax']}
            scale="time"
            tickFormatter={formatTime}
            stroke="transparent"
            tick={{ fontSize: 10, fill: '#777575' }}
            tickLine={false}
            interval="preserveStartEnd"
            tickCount={6}
          />
          <YAxis
            stroke="transparent"
            tick={{ fontSize: 10, fill: '#777575' }}
            tickFormatter={(v) => formatYValue(v, unit)}
            tickLine={false}
            width={48}
          />
          <Tooltip
            content={<CustomTooltip unit={unit} />}
            cursor={{ stroke: '#adaaaa', strokeWidth: 1, strokeDasharray: '3 3' }}
          />
          {series.map((s, i) => (
            <Line
              key={s.name}
              type="monotone"
              dataKey={s.name}
              stroke={s.color || COLORS[i % COLORS.length]}
              strokeWidth={1.5}
              dot={false}
              activeDot={{ r: 3, strokeWidth: 0 }}
              isAnimationActive={false}
            />
          ))}
        </ReLineChart>
      </ResponsiveContainer>

      {/* Compact custom legend */}
      {series.length > 1 && (
        <div className="flex flex-wrap gap-x-3 gap-y-0.5 px-1 pb-1">
          {series.map((s, i) => (
            <div key={s.name} className="flex items-center gap-1">
              <span
                className="inline-block w-3 h-0.5 rounded-full flex-shrink-0"
                style={{ background: s.color || COLORS[i % COLORS.length] }}
              />
              <span className="text-[10px] text-on-surface-variant truncate max-w-[140px]">
                {s.name}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
