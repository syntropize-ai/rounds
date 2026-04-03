// ── Types ─────────────────────────────────────────────────────────────────────

interface GaugePanelProps {
  values: { value: number; label: string }[]
  unit?: string
  loading?: boolean
}

// ── Formatters ────────────────────────────────────────────────────────────────

function formatGaugeValue(v: number, unit?: string): string {
  if (unit === 'percentunit') return `${(v * 100).toFixed(1)}%`
  if (unit === 'percent') return `${v.toFixed(1)}%`
  if (unit === 'bytes') {
    const abs = Math.abs(v)
    if (abs >= 1024 ** 3) return `${(v / 1024 ** 3).toFixed(1)}GB`
    if (abs >= 1024 ** 2) return `${(v / 1024 ** 2).toFixed(1)}MB`
    if (abs >= 1024) return `${(v / 1024).toFixed(1)}KB`
    return `${v.toFixed(0)}B`
  }
  if (unit === 'seconds') {
    if (Math.abs(v) < 1) return `${(v * 1000).toFixed(0)}ms`
    return `${v.toFixed(2)}s`
  }
  if (unit === 'ms') return `${v.toFixed(0)}ms`
  const abs = Math.abs(v)
  if (abs >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`
  if (abs >= 1_000) return `${(v / 1_000).toFixed(1)}k`
  if (abs < 0.01 && abs > 0) return v.toExponential(1)
  return v.toFixed(2).replace(/\.?0+$/, '')
}

/** Convert a raw value to a 0-100 percentage for the gauge arc. */
function toPercent(v: number, unit?: string): number {
  if (unit === 'percentunit') return Math.min(100, Math.max(0, v * 100))
  if (unit === 'percent') return Math.min(100, Math.max(0, v))
  // For other units, clamp to 0-100 as a best effort
  return Math.min(100, Math.max(0, v))
}

function gaugeColor(pct: number): string {
  if (pct >= 90) return '#ff6e84'  // red
  if (pct >= 70) return '#ffd166'  // yellow
  return '#62fae3'                  // green
}

// ── SVG Gauge Arc ─────────────────────────────────────────────────────────────

interface GaugeArcProps {
  pct: number          // 0-100
  label: string
  formattedValue: string
  color: string
}

function GaugeArc({ pct, label, formattedValue, color }: GaugeArcProps) {
  // Semicircle: from 180° to 0° (left to right), centered at cx,cy
  const cx = 60
  const cy = 56
  const r = 44
  const strokeWidth = 10

  // Helper: degrees from the negative x-axis (180° = left, 0° = right)
  // We sweep from 180° (left) to 0° (right) as value goes 0→100
  const toRad = (deg: number) => (deg * Math.PI) / 180

  // Track arc: full semicircle from 180° to 360° (= 0°)
  const trackStart = { x: cx - r, y: cy }
  const trackEnd = { x: cx + r, y: cy }

  // Value arc endpoint
  const valueDeg = 180 - pct * 1.8  // 0% = 180° (left), 100% = 0° (right)
  const valueX = cx + r * Math.cos(toRad(valueDeg))
  const valueY = cy - r * Math.sin(toRad(valueDeg))
  const largeArc = pct > 50 ? 1 : 0

  return (
    <div className="flex flex-col items-center">
      <svg width="120" height="72" viewBox="0 0 120 72" overflow="visible">
        {/* Track */}
        <path
          d={`M ${trackStart.x} ${trackStart.y} A ${r} ${r} 0 0 1 ${trackEnd.x} ${trackEnd.y}`}
          fill="none"
          stroke="#2e2e2e"
          strokeWidth={strokeWidth}
          strokeLinecap="round"
        />
        {/* Value arc */}
        {pct > 0 && (
          <path
            d={`M ${trackStart.x} ${trackStart.y} A ${r} ${r} 0 ${largeArc} 1 ${valueX} ${valueY}`}
            fill="none"
            stroke={color}
            strokeWidth={strokeWidth}
            strokeLinecap="round"
          />
        )}
        {/* Center value text */}
        <text
          x={cx}
          y={cy - 4}
          textAnchor="middle"
          dominantBaseline="auto"
          fontSize={16}
          fontWeight="700"
          fill="#e8e6e3"
          fontFamily="var(--font-display, sans-serif)"
        >
          {formattedValue}
        </text>
        {/* Zone ticks */}
        <line
          x1={cx + (r - strokeWidth / 2 - 2) * Math.cos(toRad(180 - 70 * 1.8))}
          y1={cy - (r - strokeWidth / 2 - 2) * Math.sin(toRad(180 - 70 * 1.8))}
          x2={cx + (r + strokeWidth / 2 + 2) * Math.cos(toRad(180 - 70 * 1.8))}
          y2={cy - (r + strokeWidth / 2 + 2) * Math.sin(toRad(180 - 70 * 1.8))}
          stroke="#1a1919"
          strokeWidth={2}
        />
        <line
          x1={cx + (r - strokeWidth / 2 - 2) * Math.cos(toRad(180 - 90 * 1.8))}
          y1={cy - (r - strokeWidth / 2 - 2) * Math.sin(toRad(180 - 90 * 1.8))}
          x2={cx + (r + strokeWidth / 2 + 2) * Math.cos(toRad(180 - 90 * 1.8))}
          y2={cy - (r + strokeWidth / 2 + 2) * Math.sin(toRad(180 - 90 * 1.8))}
          stroke="#1a1919"
          strokeWidth={2}
        />
      </svg>
      {label && (
        <span className="text-[10px] text-on-surface-variant/60 truncate max-w-[110px] text-center -mt-1">
          {label}
        </span>
      )}
    </div>
  )
}

// ── GaugePanel ────────────────────────────────────────────────────────────────

export function GaugePanel({ values, unit, loading = false }: GaugePanelProps) {
  if (loading) {
    return (
      <div className="flex-1 flex items-center justify-center min-h-[80px]">
        <span className="w-5 h-5 border-2 border-primary/30 border-t-primary rounded-full animate-spin" />
      </div>
    )
  }

  if (!values || values.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center text-on-surface-variant/50 text-xs min-h-[80px]">
        No data
      </div>
    )
  }

  return (
    <div className="flex-1 flex flex-wrap items-center justify-center gap-4 min-h-[80px]">
      {values.map((sv, i) => {
        const pct = toPercent(sv.value, unit)
        return (
          <GaugeArc
            key={i}
            pct={pct}
            label={sv.label}
            formattedValue={formatGaugeValue(sv.value, unit)}
            color={gaugeColor(pct)}
          />
        )
      })}
    </div>
  )
}
