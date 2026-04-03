import { useTimeRange, TimeRangePreset } from '@/stores/timeRange'
import { useAIPanel } from '@/stores/aiPanel'

const PRESETS: TimeRangePreset[] = ['15m', '1h', '3h', '6h', '12h', '24h', '7d']

interface TopBarProps {
  title?: string
  showTimeRange?: boolean
  onDelete?: () => void
}

export function TopBar({ title, showTimeRange = true, onDelete }: TopBarProps) {
  const { preset, setPreset } = useTimeRange()
  const { toggle } = useAIPanel()

  return (
    <div className="flex items-center justify-between px-6 h-14 bg-surface flex-shrink-0">
      {title && <h1 className="font-display font-bold text-base text-on-surface">{title}</h1>}
      <div className="flex items-center gap-3 ml-auto">
        {showTimeRange && (
          <div className="flex items-center gap-1 bg-surface-high rounded-xl p-1">
            {PRESETS.map((p) => (
              <button
                key={p}
                onClick={() => setPreset(p)}
                className={`px-2.5 py-1 rounded-lg text-xs font-medium transition-all ${
                  preset === p
                    ? 'bg-primary/20 text-primary'
                    : 'text-on-surface-variant hover:text-on-surface'
                }`}
              >
                {p}
              </button>
            ))}
          </div>
        )}
        <button className="p-2 rounded-xl text-on-surface-variant hover:bg-surface-high hover:text-on-surface transition-all">
          <span className="material-symbols-rounded text-xl">share</span>
        </button>
        <button className="p-2 rounded-xl text-on-surface-variant hover:bg-surface-high hover:text-on-surface transition-all">
          <span className="material-symbols-rounded text-xl">notifications</span>
        </button>
        {onDelete && (
          <button
            onClick={onDelete}
            className="p-2 rounded-xl text-on-surface-variant hover:bg-error/20 hover:text-error transition-all"
            title="Delete dashboard"
          >
            <span className="material-symbols-rounded text-xl">delete</span>
          </button>
        )}
        <button
          onClick={toggle}
          className="p-2 rounded-xl text-on-surface-variant hover:bg-surface-high hover:text-on-surface transition-all"
          title="Toggle AI Panel"
        >
          <span className="material-symbols-rounded text-xl">smart_toy</span>
        </button>
      </div>
    </div>
  )
}
