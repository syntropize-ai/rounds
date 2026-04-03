import { useState } from 'react'
import { Link, useLocation } from 'react-router-dom'
import { cn } from '@/lib/cn'

const navItems = [
  { icon: 'home', label: 'Home', to: '/' },
  { icon: 'grid_view', label: 'Dashboards', to: '/explorer' },
  { icon: 'folder_open', label: 'Explorer', to: '/explorer' },
  { icon: 'description', label: 'Reports', to: '/explorer' },
  { icon: 'notifications', label: 'Alerts', to: '/alerts/new' },
]

export function SideNav() {
  const [expanded, setExpanded] = useState(false)
  const location = useLocation()

  return (
    <nav
      className={cn(
        'flex flex-col h-screen bg-surface-low transition-all duration-300 flex-shrink-0',
        expanded ? 'w-56' : 'w-16'
      )}
      onMouseEnter={() => setExpanded(true)}
      onMouseLeave={() => setExpanded(false)}
    >
      {/* Logo */}
      <div className="flex items-center gap-3 px-4 py-5 h-16">
        <div className="w-8 h-8 rounded-lg gradient-primary flex items-center justify-center flex-shrink-0">
          <span className="material-symbols-rounded text-black text-sm">auto_awesome</span>
        </div>
        {expanded && (
          <span className="font-display font-bold text-base gradient-text whitespace-nowrap">Curator</span>
        )}
      </div>

      {/* New Analysis button */}
      <div className="px-3 mb-4">
        <Link to="/" className={cn('gradient-primary rounded-xl flex items-center gap-2 text-black font-medium text-sm', expanded ? 'px-3 py-2' : 'p-2 justify-center')}>
          <span className="material-symbols-rounded text-base">add</span>
          {expanded && 'New Analysis'}
        </Link>
      </div>

      {/* Nav items */}
      <div className="flex flex-col gap-1 px-2 flex-1">
        {navItems.map((item) => {
          const active = location.pathname === item.to || (item.to !== '/' && location.pathname.startsWith(item.to))
          return (
            <Link
              key={item.label}
              to={item.to}
              className={cn(
                'flex items-center gap-3 px-3 py-2.5 rounded-xl transition-all text-sm',
                active
                  ? 'bg-primary/20 text-primary'
                  : 'text-on-surface-variant hover:bg-surface-high hover:text-on-surface'
              )}
            >
              <span className="material-symbols-rounded text-xl flex-shrink-0">{item.icon}</span>
              {expanded && <span className="whitespace-nowrap">{item.label}</span>}
            </Link>
          )
        })}
      </div>

      {/* Bottom */}
      <div className="px-2 pb-4 flex flex-col gap-1">
        <button className="flex items-center gap-3 px-3 py-2.5 rounded-xl text-on-surface-variant hover:bg-surface-high hover:text-on-surface transition-all text-sm">
          <span className="material-symbols-rounded text-xl flex-shrink-0">menu_book</span>
          {expanded && <span className="whitespace-nowrap">Docs</span>}
        </button>
        <Link to="/settings" className={cn('flex items-center gap-3 px-3 py-2.5 rounded-xl transition-all text-sm', location.pathname === '/settings' ? 'bg-primary/20 text-primary' : 'text-on-surface-variant hover:bg-surface-high hover:text-on-surface')}>
          <span className="material-symbols-rounded text-xl flex-shrink-0">settings</span>
          {expanded && <span className="whitespace-nowrap">Settings</span>}
        </Link>
        {/* User */}
        <div className={cn('flex items-center gap-3 px-3 py-2.5 rounded-xl text-on-surface-variant text-sm')}>
          <div className="w-7 h-7 rounded-full bg-primary/30 flex items-center justify-center text-primary text-xs font-bold flex-shrink-0">
            A
          </div>
          {expanded && (
            <div className="overflow-hidden">
              <div className="text-on-surface text-xs font-medium truncate">Alex Chen</div>
              <div className="text-on-surface-variant text-xs truncate">Site Reliability</div>
            </div>
          )}
        </div>
      </div>
    </nav>
  )
}
