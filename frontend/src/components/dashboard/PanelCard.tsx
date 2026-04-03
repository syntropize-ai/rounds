import { ReactNode } from 'react'

interface PanelCardProps {
  title: string
  children: ReactNode
  className?: string
}

export function PanelCard({ title, children, className = '' }: PanelCardProps) {
  return (
    <div className={`bg-surface-high rounded-2xl p-4 flex flex-col gap-3 ${className}`}>
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-medium text-on-surface-variant">{title}</h3>
        <button className="text-on-surface-variant/40 hover:text-on-surface-variant transition-all">
          <span className="material-symbols-rounded text-base">drag_indicator</span>
        </button>
      </div>
      {children}
    </div>
  )
}
