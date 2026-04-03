import {
  ResponsiveContainer,
  BarChart as ReBarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Cell,
  TooltipProps,
} from 'recharts'

// ── Types ─────────────────────────────────────────────────────────────────────

interface BarChartProps {
  data: { label: string; value: number }[]
  height?: number
  color?: string
  unit?: string
  loading?: boolean
  horizontal?: boolean
}

// ── Formatters ────────────────────────────────────────────────────────────────

function formatValue(v: number, unit?: string): string {
  const abs = Math.abs(v)
  let num: string
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

// ── Custom Tooltip ────────────────────────────────────────────────────────────

function CustomTooltip({
  active,
  payload,
  unit,
}: TooltipProps<number, string> & { unit?: string }) {
  if (!active || !payload || payload.length === 0) return null
  const entry = payload[0]
  return (
    <div
      style={{
        background: '#1a1919',
        border: '1px solid #2e2e2e',
        borderRadius: 8,
        padding: '6px 10px',
        fontSize: 11,
      }}
    >
      <div style={{ color: '#adaaaa', marginBottom: 2 }}>{entry.payload?.label}</div>
      <div style={{ color: '#e8e6e3', fontWeight: 600 }}>{formatValue(entry.value ?? 0, unit)}</div>
    </div>
  )
}

// ── BarChart ──────────────────────────────────────────────────────────────────

export function BarChart({
  data,
  height = 180,
  color = '#a3a6ff',
  unit = '',
  loading = false,
  horizontal = false,
}: BarChartProps) {
  if (loading) {
    return (
      <div className="flex items-center justify-center" style={{ height }}>
        <span className="w-5 h-5 border-2 border-primary/30 border-t-primary rounded-full animate-spin" />
      </div>
    )
  }

  if (!data || data.length === 0) {
    return (
      <div
        className="flex items-center justify-center text-on-surface-variant/50 text-xs"
        style={{ height }}
      >
        No data
      </div>
    )
  }

  if (horizontal) {
    return (
      <ResponsiveContainer width="100%" height={height}>
        <ReBarChart
          layout="vertical"
          data={data}
          margin={{ top: 4, right: 16, left: 0, bottom: 0 }}
        >
          <CartesianGrid strokeDasharray="3 3" stroke="#262626" horizontal={false} />
          <XAxis
            type="number"
            stroke="transparent"
            tick={{ fontSize: 10, fill: '#777575' }}
            tickLine={false}
            tickFormatter={(v) => formatValue(v, unit)}
          />
          <YAxis
            type="category"
            dataKey="label"
            stroke="transparent"
            tick={{ fontSize: 10, fill: '#adaaaa' }}
            tickLine={false}
            width={80}
          />
          <Tooltip content={<CustomTooltip unit={unit} />} cursor={{ fill: '#ffffff08' }} />
          <Bar dataKey="value" radius={[0, 3, 3, 0]} isAnimationActive={false}>
            {data.map((_, i) => (
              <Cell key={i} fill={color} />
            ))}
          </Bar>
        </ReBarChart>
      </ResponsiveContainer>
    )
  }

  return (
    <ResponsiveContainer width="100%" height={height}>
      <ReBarChart data={data} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="#262626" vertical={false} />
        <XAxis
          dataKey="label"
          stroke="transparent"
          tick={{ fontSize: 10, fill: '#adaaaa' }}
          tickLine={false}
        />
        <YAxis
          stroke="transparent"
          tick={{ fontSize: 10, fill: '#777575' }}
          tickFormatter={(v) => formatValue(v, unit)}
          tickLine={false}
          width={48}
        />
        <Tooltip content={<CustomTooltip unit={unit} />} cursor={{ fill: '#ffffff08' }} />
        <Bar dataKey="value" radius={[3, 3, 0, 0]} isAnimationActive={false}>
          {data.map((_, i) => (
            <Cell key={i} fill={color} />
          ))}
        </Bar>
      </ReBarChart>
    </ResponsiveContainer>
  )
}
