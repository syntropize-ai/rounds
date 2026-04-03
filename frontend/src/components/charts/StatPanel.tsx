// ── Types ─────────────────────────────────────────────────────────────────────

interface StatPanelProps {
  values: { value: number; label: string }[]
  unit?: string
  loading?: boolean
}

// ── Formatters ────────────────────────────────────────────────────────────────

function formatStatValue(v: number, unit?: string): string {
  if (unit === 'percentunit') {
    return `${(v * 100).toFixed(1)}%`
  }
  if (unit === 'percent') {
    return `${v.toFixed(1)}%`
  }
  if (unit === 'bytes') {
    const abs = Math.abs(v)
    if (abs >= 1024 ** 4) return `${(v / 1024 ** 4).toFixed(2)} TB`
    if (abs >= 1024 ** 3) return `${(v / 1024 ** 3).toFixed(2)} GB`
    if (abs >= 1024 ** 2) return `${(v / 1024 ** 2).toFixed(1)} MB`
    if (abs >= 1024) return `${(v / 1024).toFixed(1)} KB`
    return `${v.toFixed(0)} B`
  }
  if (unit === 'seconds') {
    const abs = Math.abs(v)
    if (abs < 0.001) return `${(v * 1_000_000).toFixed(0)}µs`
    if (abs < 1) return `${(v * 1000).toFixed(0)}ms`
    if (abs < 60) return `${v.toFixed(2)}s`
    const m = Math.floor(v / 60)
    const s = Math.floor(v % 60)
    return `${m}m ${s}s`
  }
  if (unit === 'ms') {
    const abs = Math.abs(v)
    if (abs < 1000) return `${v.toFixed(0)}ms`
    if (abs < 60_000) return `${(v / 1000).toFixed(2)}s`
    const m = Math.floor(v / 60_000)
    const s = Math.floor((v % 60_000) / 1000)
    return `${m}m ${s}s`
  }
  if (unit === 'reqps') {
    const abs = Math.abs(v)
    if (abs >= 1_000_000) return `${(v / 1_000_000).toFixed(2)}M req/s`
    if (abs >= 1_000) return `${(v / 1_000).toFixed(1)}k req/s`
    return `${v.toFixed(1)} req/s`
  }
  // Generic number formatting
  const abs = Math.abs(v)
  if (abs >= 1_000_000_000) return `${(v / 1_000_000_000).toFixed(2)}G`
  if (abs >= 1_000_000) return `${(v / 1_000_000).toFixed(2)}M`
  if (abs >= 1_000) return `${(v / 1_000).toFixed(1)}k`
  if (abs === 0) return '0'
  if (abs < 0.01) return v.toExponential(2)
  if (abs < 1) return v.toFixed(3).replace(/\.?0+$/, '')
  return v.toFixed(2).replace(/\.?0+$/, '')
}

// ── StatPanel ─────────────────────────────────────────────────────────────────

export function StatPanel({ values, unit, loading = false }: StatPanelProps) {
  if (loading) {
    return (
      <div className="flex-1 flex items-center justify-center min-h-[72px]">
        <span className="w-5 h-5 border-2 border-primary/30 border-t-primary rounded-full animate-spin" />
      </div>
    )
  }

  if (!values || values.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center text-on-surface-variant/50 text-xs min-h-[72px]">
        No data
      </div>
    )
  }

  // Multiple stat values: show a row of stats
  if (values.length > 1) {
    return (
      <div className="flex-1 flex flex-wrap items-center justify-center gap-4 min-h-[72px] px-2">
        {values.map((sv, i) => (
          <div key={i} className="flex flex-col items-center gap-0.5">
            <span className="text-2xl font-bold font-display text-primary tabular-nums">
              {formatStatValue(sv.value, unit)}
            </span>
            <span className="text-[10px] text-on-surface-variant/60 truncate max-w-[120px] text-center">
              {sv.label}
            </span>
          </div>
        ))}
      </div>
    )
  }

  const sv = values[0]
  return (
    <div className="flex-1 flex flex-col items-center justify-center gap-1 min-h-[72px]">
      <span className="text-3xl font-bold font-display text-primary tabular-nums">
        {formatStatValue(sv.value, unit)}
      </span>
      {sv.label && (
        <span className="text-xs text-on-surface-variant/60 font-mono text-center line-clamp-1 px-2">
          {sv.label}
        </span>
      )}
    </div>
  )
}
