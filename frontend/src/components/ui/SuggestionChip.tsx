interface SuggestionChipProps {
  label: string
  icon?: string
  onClick?: () => void
}

export function SuggestionChip({ label, icon, onClick }: SuggestionChipProps) {
  return (
    <button
      onClick={onClick}
      className="flex items-center gap-2 px-3 py-2 rounded-xl border border-outline/30 text-on-surface-variant text-sm hover:border-primary/40 hover:text-on-surface transition-all"
    >
      {icon && <span className="material-symbols-rounded text-base">{icon}</span>}
      {label}
    </button>
  )
}
