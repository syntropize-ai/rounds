import React, { useState, useEffect, useRef } from 'react';
import { NavLink, useNavigate, useLocation } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext.js';
import { useTheme } from '../contexts/ThemeContext.js';
import { OpenObsLogo } from './OpenObsLogo.js';
import { OrgSwitcher } from './OrgSwitcher.js';
import { plansApi } from '../api/client.js';

/* ───── Icon components ───── */

/* Home — pulse/activity overview */
function HomeIcon({ className }: { className?: string }) {
  return (
    <svg className={className ?? 'w-5 h-5'} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M2 12h4l3-9 4 18 3-9h6" />
    </svg>
  );
}

function DashboardIcon({ className }: { className?: string }) {
  return (
    <svg className={className ?? 'w-5 h-5'} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
      <rect x="3" y="3" width="7" height="9" rx="1.5" strokeLinecap="round" strokeLinejoin="round" />
      <rect x="14" y="3" width="7" height="5" rx="1.5" strokeLinecap="round" strokeLinejoin="round" />
      <rect x="3" y="16" width="7" height="5" rx="1.5" strokeLinecap="round" strokeLinejoin="round" />
      <rect x="14" y="12" width="7" height="9" rx="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/* Investigation — compass/explore icon */
function InvestigationIcon({ className }: { className?: string }) {
  return (
    <svg className={className ?? 'w-5 h-5'} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
      <circle cx="12" cy="12" r="9" strokeLinecap="round" strokeLinejoin="round" />
      <polygon points="16.24,7.76 14.12,14.12 7.76,16.24 9.88,9.88" stroke="currentColor" strokeWidth={1.8} strokeLinejoin="round" fill="none" />
    </svg>
  );
}

/* Actions — checkmark/clipboard icon for the Action Center */
function ActionsIcon({ className }: { className?: string }) {
  return (
    <svg className={className ?? 'w-5 h-5'} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9l2 2 4-4" />
    </svg>
  );
}

function AlertsIcon({ className }: { className?: string }) {
  return (
    <svg className={className ?? 'w-5 h-5'} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9" />
    </svg>
  );
}

function SettingsIcon({ className }: { className?: string }) {
  return (
    <svg className={className ?? 'w-5 h-5'} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.066 2.573c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.573 1.066c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.066-2.573c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
      <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
    </svg>
  );
}

/* Admin — shield icon (distinct from dashboard permissions shield by outline) */
function AdminIcon({ className }: { className?: string }) {
  return (
    <svg className={className ?? 'w-5 h-5'} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M12 2l8 3v6c0 5-3.5 9.5-8 11-4.5-1.5-8-6-8-11V5l8-3z" />
      <path strokeLinecap="round" strokeLinejoin="round" d="M9 12l2 2 4-4" />
    </svg>
  );
}

/* Sun / Moon icons for theme toggle */

function SunIcon({ className }: { className?: string }) {
  return (
    <svg className={className ?? 'w-5 h-5'} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
      <circle cx="12" cy="12" r="4" strokeLinecap="round" strokeLinejoin="round" />
      <path strokeLinecap="round" strokeLinejoin="round" d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41" />
    </svg>
  );
}

function MoonIcon({ className }: { className?: string }) {
  return (
    <svg className={className ?? 'w-5 h-5'} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M21 12.79A9 9 0 1111.21 3 7 7 0 0021 12.79z" />
    </svg>
  );
}

/* ───── Sidebar toggle icon (shown on hover) ───── */

function SidebarToggleIcon({ expanded, className }: { expanded: boolean; className?: string }) {
  return (
    <svg className={className ?? 'w-5 h-5'} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8}>
      <rect x="3" y="3" width="18" height="18" rx="3" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M9 3v18" strokeLinecap="round" />
      {expanded
        ? <path d="M15 10l-2 2 2 2" strokeLinecap="round" strokeLinejoin="round" />
        : <path d="M14 10l2 2-2 2" strokeLinecap="round" strokeLinejoin="round" />
      }
    </svg>
  );
}

/* ───── Sidebar nav item ───── */

interface SidebarItemProps {
  to: string;
  label: string;
  icon: React.ReactNode;
  end?: boolean;
  expanded: boolean;
  /** Optional small badge (e.g. pending count) shown on the icon / label. */
  badge?: number;
}

function SidebarItem({ to, label, icon, end, expanded, badge }: SidebarItemProps) {
  const showBadge = typeof badge === 'number' && badge > 0;
  const badgeLabel = showBadge ? (badge > 99 ? '99+' : String(badge)) : null;
  return (
    <NavLink
      to={to}
      end={end}
      title={expanded ? undefined : (showBadge ? `${label} (${badgeLabel} pending)` : label)}
      className={({ isActive }) =>
        `relative flex items-center gap-3 h-10 rounded-lg transition-colors ${
          expanded ? 'px-3 w-full' : 'justify-center w-10'
        } ${
          isActive
            ? 'text-on-surface bg-surface-high'
            : 'text-on-surface-variant hover:text-on-surface hover:bg-surface-high/60'
        }`
      }
    >
      <span className="relative inline-flex">
        {icon}
        {showBadge && !expanded && (
          <span
            aria-label={`${badgeLabel} pending`}
            className="absolute -top-1 -right-1.5 min-w-[16px] h-4 px-1 rounded-full bg-primary text-on-primary-fixed text-[10px] font-bold leading-4 text-center"
          >
            {badgeLabel}
          </span>
        )}
      </span>
      {expanded && (
        <>
          <span className="text-sm font-medium truncate">{label}</span>
          {showBadge && (
            <span
              aria-label={`${badgeLabel} pending`}
              className="ml-auto inline-flex items-center justify-center min-w-[18px] h-[18px] px-1.5 rounded-full bg-primary text-on-primary-fixed text-[10px] font-bold"
            >
              {badgeLabel}
            </span>
          )}
        </>
      )}
    </NavLink>
  );
}

/* ───── User avatar menu ───── */

interface UserMenuProps {
  user: { name: string; email?: string; avatarUrl?: string };
  expanded: boolean;
  onLogout: () => void;
}

function UserMenu({ user, expanded, onLogout }: UserMenuProps) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);

  // Close on outside click / Escape — standard popover semantics.
  useEffect(() => {
    if (!open) return;
    function onDocMouseDown(e: MouseEvent) {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false);
    }
    document.addEventListener('mousedown', onDocMouseDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDocMouseDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div className="relative mt-2" ref={wrapRef}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        title={user.name}
        aria-haspopup="menu"
        aria-expanded={open}
        className={`flex items-center gap-2 rounded-full transition-colors hover:bg-primary/30 overflow-hidden ${
          expanded ? 'px-2 py-1.5 rounded-lg w-full' : 'justify-center w-8 h-8'
        } bg-primary/20 text-primary`}
      >
        <div className="flex items-center justify-center w-8 h-8 rounded-full text-xs font-bold shrink-0">
          {user.avatarUrl ? (
            <img src={user.avatarUrl} alt="" className="w-full h-full object-cover rounded-full" />
          ) : (
            user.name.charAt(0).toUpperCase()
          )}
        </div>
        {expanded && <span className="text-xs font-medium truncate">{user.name}</span>}
      </button>

      {open && (
        <div
          role="menu"
          className={`absolute z-50 ${expanded ? 'left-0 right-0' : 'left-full ml-2'} bottom-full mb-2 min-w-[12rem] rounded-lg border border-outline bg-surface-lowest shadow-lg py-1`}
        >
          <div className="px-3 py-2 border-b border-outline/40">
            <div className="text-sm font-medium text-on-surface truncate">{user.name}</div>
            {user.email && (
              <div className="text-xs text-on-surface-variant truncate">{user.email}</div>
            )}
          </div>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setOpen(false);
              onLogout();
            }}
            className="w-full text-left px-3 py-2 text-sm text-on-surface hover:bg-surface-high/70 transition-colors"
          >
            Sign out
          </button>
        </div>
      )}
    </div>
  );
}

/* ───── Main navigation sidebar ───── */

export default function Navigation() {
  const navigate = useNavigate();
  const location = useLocation();
  const { user, logout, hasPermission } = useAuth();
  const { theme, toggleTheme } = useTheme();
  // T9 / Wave 6 — show /admin in nav when the current principal has any
  // users:read / orgs:read, or is a server admin. Matches the gating used by
  // the admin page tabs themselves so the link doesn't land on a 403.
  const canSeeAdmin =
    !!user
    && (user.isServerAdmin
      || hasPermission('users:read')
      || hasPermission('orgs:read')
      || hasPermission('teams:read')
      || hasPermission('serviceaccounts:read'));
  // Settings page hosts write-only surfaces (datasources / LLM / notifications).
  // Viewers have no grant there, so hiding the entry matches Grafana's
  // behaviour and avoids a "Add source" button that 403s on click.
  const canSeeSettings =
    !!user
    && (user.isServerAdmin
      || hasPermission('datasources:write')
      || hasPermission('datasources:create')
      || hasPermission('admin:write'));
  // Default expanded, persisted across sessions. User's explicit toggle wins
  // over any route-based behavior (we used to auto-collapse when leaving Home,
  // which fought against users who preferred the expanded rail everywhere).
  const [expanded, setExpanded] = useState<boolean>(() => {
    if (typeof window === 'undefined') return true;
    const saved = window.localStorage.getItem('openobs:sidebar-expanded');
    return saved === null ? true : saved === '1';
  });

  useEffect(() => {
    if (typeof window === 'undefined') return;
    window.localStorage.setItem('openobs:sidebar-expanded', expanded ? '1' : '0');
  }, [expanded]);

  // Pending-plan badge for the Action Center entry. Polled every 30s
  // (per the UX brief) so operators see remediation work waiting on them
  // even if they aren't on the alerts/investigation pages.
  const [pendingPlans, setPendingPlans] = useState(0);
  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    const fetchOnce = () => {
      void plansApi.list({ status: 'pending_approval' })
        .then(({ data }) => {
          if (!cancelled) setPendingPlans(data?.length ?? 0);
        })
        .catch(() => { /* non-fatal — leave previous count */ });
    };
    fetchOnce();
    const timer = setInterval(fetchOnce, 30_000);
    return () => { cancelled = true; clearInterval(timer); };
  }, [user]);

  const handleLogout = async () => {
    await logout();
    navigate('/login', { replace: true });
  };

  return (
    <nav
      className={`flex flex-col h-full bg-surface-lowest border-r border-outline py-3 shrink-0 transition-all duration-200 ${
        expanded ? 'w-48 px-2' : 'w-14 items-center'
      }`}
    >
      {/* App logo + toggle */}
      <div className={`flex items-center mb-5 ${expanded ? 'justify-between px-1' : 'flex-col gap-1'}`}>
        {/* Logo — collapsed: hover to show toggle; expanded: always show logo */}
        {expanded ? (
          <div className="flex items-center gap-2.5 min-w-0">
            <div className="flex items-center justify-center w-10 h-10 text-on-surface shrink-0">
              <OpenObsLogo className="w-6 h-6" />
            </div>
            <span className="text-sm font-bold text-on-surface truncate">OpenObs</span>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => setExpanded(true)}
            title="Open sidebar"
            className="group"
          >
            <div className="relative flex items-center justify-center w-10 h-10 text-on-surface shrink-0 group-hover:bg-surface-high/60 transition-colors">
              <span className="transition-opacity duration-150 group-hover:opacity-0">
                <OpenObsLogo className="w-6 h-6" />
              </span>
              <span className="absolute inset-0 flex items-center justify-center opacity-0 transition-opacity duration-150 group-hover:opacity-100 text-on-surface">
                <SidebarToggleIcon expanded={false} />
              </span>
            </div>
          </button>
        )}

        {/* Close button — only visible when expanded */}
        {expanded && (
          <button
            type="button"
            onClick={() => setExpanded(false)}
            title="Close sidebar"
            className="flex items-center justify-center w-8 h-8 rounded-lg text-on-surface-variant hover:text-on-surface hover:bg-surface-high/60 transition-colors"
          >
            <SidebarToggleIcon expanded={true} className="w-[18px] h-[18px]" />
          </button>
        )}
      </div>

      {/* Org switcher — shown above nav items when sidebar is expanded.
          Hidden automatically when the user has <= 1 org. */}
      {expanded && (
        <div className="mb-3">
          <OrgSwitcher compact />
        </div>
      )}

      {/* Primary nav items */}
      <div className={`flex flex-col gap-1 flex-1 ${expanded ? '' : 'items-center'}`}>
        <SidebarItem to="/" label="Home" icon={<HomeIcon />} end expanded={expanded} />
        <SidebarItem to="/dashboards" label="Dashboards" icon={<DashboardIcon />} expanded={expanded} />
        <SidebarItem to="/investigations" label="Investigations" icon={<InvestigationIcon />} expanded={expanded} />
        <SidebarItem to="/alerts" label="Alerts" icon={<AlertsIcon />} expanded={expanded} />
        <SidebarItem to="/actions" label="Actions" icon={<ActionsIcon />} expanded={expanded} badge={pendingPlans} />
      </div>

      {/* Bottom nav items */}
      <div className={`flex flex-col gap-1 mt-auto ${expanded ? '' : 'items-center'}`}>
        {/* Theme toggle */}
        <button
          type="button"
          onClick={toggleTheme}
          title={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
          className={`flex items-center gap-3 h-10 rounded-lg transition-colors text-on-surface-variant hover:text-on-surface hover:bg-surface-high/60 ${
            expanded ? 'px-3 w-full' : 'justify-center w-10'
          }`}
        >
          {theme === 'dark' ? <SunIcon /> : <MoonIcon />}
          {expanded && (
            <span className="text-sm font-medium truncate">
              {theme === 'dark' ? 'Light mode' : 'Dark mode'}
            </span>
          )}
        </button>

        {canSeeAdmin && (
          <SidebarItem to="/admin" label="Admin" icon={<AdminIcon />} expanded={expanded} />
        )}

        {canSeeSettings && (
          <SidebarItem to="/settings" label="Settings" icon={<SettingsIcon />} expanded={expanded} />
        )}

        {/* User avatar — opens a small menu. Clicking the avatar itself used
            to sign the user out directly, which surprised everyone who
            expected a profile menu. Now it toggles a popover that contains
            the explicit Sign-out action. */}
        {user && (
          <UserMenu user={user} expanded={expanded} onLogout={() => void handleLogout()} />
        )}
      </div>
    </nav>
  );
}
