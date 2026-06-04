import React, { useState, useEffect, useRef, useCallback } from 'react';
import { NavLink, useNavigate, useLocation } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext.js';
import { useGlobalChat } from '../contexts/ChatContext.js';
import { RoundsLogo } from './RoundsLogo.js';
import { OrgSwitcher } from './OrgSwitcher.js';
import { apiClient, plansApi } from '../api/client.js';

/** Recent chat session shown in the sidebar Recents tab. */
interface RecentSession {
  id: string;
  title?: string | null;
  createdAt: string;
  updatedAt?: string;
}

type SidebarTab = 'nav' | 'recents';

function relativeTime(iso: string | undefined): string {
  if (!iso) return '';
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '';
  const diff = Date.now() - then;
  const min = Math.floor(diff / 60_000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day < 7) return `${day}d ago`;
  return new Date(iso).toLocaleDateString();
}

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
  canSeeAdmin: boolean;
  onLogout: () => void;
}

function UserMenu({ user, expanded, canSeeAdmin, onLogout }: UserMenuProps) {
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
          <NavLink
            to="/settings"
            role="menuitem"
            onClick={() => setOpen(false)}
            className="block px-3 py-2 text-sm text-on-surface hover:bg-surface-high/70 transition-colors"
          >
            Settings
          </NavLink>
          {canSeeAdmin && (
            <NavLink
              to="/admin"
              role="menuitem"
              onClick={() => setOpen(false)}
              className="block px-3 py-2 text-sm text-on-surface hover:bg-surface-high/70 transition-colors"
            >
              Admin
            </NavLink>
          )}
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
  const canSeeAdmin =
    !!user
    && (user.isServerAdmin
      || hasPermission('users:read')
      || hasPermission('org.users:read')
      || hasPermission('teams:read')
      || hasPermission('serviceaccounts:read')
      || hasPermission('roles:read')
      || hasPermission('server.audit:read'));
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

  // Sidebar tab — 'nav' shows the route links, 'recents' shows recent chat
  // sessions. Persisted so it survives reload, mirroring `expanded`. Tabs
  // only render when the rail is expanded; the collapsed icon-only mode
  // always falls back to the nav.
  const [activeTab, setActiveTab] = useState<SidebarTab>(() => {
    if (typeof window === 'undefined') return 'nav';
    const saved = window.localStorage.getItem('openobs:sidebar-tab');
    return saved === 'recents' ? 'recents' : 'nav';
  });

  useEffect(() => {
    if (typeof window === 'undefined') return;
    window.localStorage.setItem('openobs:sidebar-tab', activeTab);
  }, [activeTab]);

  // Recent sessions — fetched only when the Recents tab is active or about
  // to become active so we don't poll the chat API for users who never look
  // at it. Mirrors the limit/refresh pattern Home.tsx uses.
  const globalChat = useGlobalChat();
  const [sessions, setSessions] = useState<RecentSession[]>([]);
  const [deletingSessionId, setDeletingSessionId] = useState<string | null>(null);
  const refreshSessions = useCallback(() => {
    void apiClient
      .get<{ sessions: RecentSession[] }>('/chat/sessions?limit=20')
      .then((res) => {
        if (!res.error && res.data?.sessions) setSessions(res.data.sessions);
      });
  }, []);

  useEffect(() => {
    if (activeTab !== 'recents' || !user) return;
    refreshSessions();
  }, [activeTab, user, refreshSessions]);

  // Refresh when a generation finishes — mirrors Home's behavior so a new
  // session shows up in the sidebar list as soon as the model finalizes.
  const wasGeneratingRef = useRef(false);
  useEffect(() => {
    if (activeTab !== 'recents') return;
    if (wasGeneratingRef.current && !globalChat.isGenerating) {
      refreshSessions();
    }
    wasGeneratingRef.current = globalChat.isGenerating;
  }, [activeTab, globalChat.isGenerating, refreshSessions]);

  const activeSessionId = globalChat.currentSessionId || undefined;

  const openSession = useCallback(
    (sessionId: string) => {
      void globalChat.loadSession(sessionId);
      // No URL mutation — session id lives in ChatProvider's React state.
      // Just ensure we're on Home so the conversation surface is visible.
      if (location.pathname !== '/') navigate('/');
    },
    [globalChat, navigate, location.pathname],
  );

  const startNew = useCallback(() => {
    globalChat.startNewSession();
    if (location.pathname !== '/') navigate('/');
  }, [globalChat, navigate, location.pathname]);

  const deleteSession = useCallback(
    async (sessionId: string) => {
      if (deletingSessionId) return;
      setDeletingSessionId(sessionId);
      const wasActive = sessionId === activeSessionId;
      if (wasActive) {
        globalChat.startNewSession();
        if (location.pathname !== '/') navigate('/');
      }
      const res = await apiClient.delete<unknown>(
        `/chat/sessions/${encodeURIComponent(sessionId)}`,
      );
      setDeletingSessionId(null);
      if (res.error) {
        refreshSessions();
        return;
      }
      setSessions((prev) => prev.filter((session) => session.id !== sessionId));
    },
    [activeSessionId, deletingSessionId, globalChat, location.pathname, navigate, refreshSessions],
  );

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
              <RoundsLogo className="w-7 h-7" />
            </div>
            <span className="text-sm font-bold text-on-surface truncate">Rounds</span>
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
                <RoundsLogo className="w-7 h-7" />
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

      {/* Tab strip — Nav vs Recents (chat sessions). Only renders in
          expanded mode; the collapsed icon rail always shows the nav so
          there's no surprise "where did Home go" when users collapse. */}
      {expanded && (
        <div
          role="tablist"
          aria-label="Sidebar view"
          className="mb-2 flex items-center gap-1 rounded-lg bg-surface-high/40 p-1 text-xs font-medium"
        >
          {(['nav', 'recents'] as const).map((tab) => (
            <button
              key={tab}
              type="button"
              role="tab"
              aria-selected={activeTab === tab}
              onClick={() => setActiveTab(tab)}
              className={`flex-1 rounded-md py-1.5 transition-colors ${
                activeTab === tab
                  ? 'bg-surface-lowest text-on-surface shadow-sm'
                  : 'text-on-surface-variant hover:text-on-surface'
              }`}
            >
              {tab === 'nav' ? 'Nav' : 'Recents'}
            </button>
          ))}
        </div>
      )}

      {/* Primary nav items — always rendered when collapsed; in expanded
          mode only when the Nav tab is active. */}
      {(activeTab === 'nav' || !expanded) && (
        <div className={`flex flex-col gap-1 flex-1 ${expanded ? '' : 'items-center'}`}>
          <SidebarItem to="/" label="Home" icon={<HomeIcon />} end expanded={expanded} />
          <SidebarItem to="/dashboards" label="Dashboards" icon={<DashboardIcon />} expanded={expanded} />
          <SidebarItem to="/investigations" label="Investigations" icon={<InvestigationIcon />} expanded={expanded} />
          <SidebarItem to="/alerts" label="Alerts" icon={<AlertsIcon />} expanded={expanded} />
          <SidebarItem to="/actions" label="Actions" icon={<ActionsIcon />} expanded={expanded} badge={pendingPlans} />
        </div>
      )}

      {/* Recents tab — list of recent chat sessions + new-chat button.
          Only renders in expanded mode; collapsed mode always shows nav. */}
      {expanded && activeTab === 'recents' && (
        <div className="flex flex-col flex-1 min-h-0">
          <button
            type="button"
            onClick={startNew}
            className="mb-2 flex items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium text-on-surface hover:bg-surface-high/60 transition-colors"
          >
            <svg className="w-4 h-4" viewBox="0 0 20 20" fill="currentColor">
              <path
                fillRule="evenodd"
                d="M10 3a1 1 0 011 1v5h5a1 1 0 110 2h-5v5a1 1 0 11-2 0v-5H4a1 1 0 110-2h5V4a1 1 0 011-1z"
                clipRule="evenodd"
              />
            </svg>
            New chat
          </button>
          <div className="flex-1 min-h-0 overflow-y-auto -mr-1 pr-1">
            {sessions.length === 0 ? (
              <p className="px-2 py-3 text-xs text-on-surface-variant">
                No conversations yet.
              </p>
            ) : (
              <ul className="flex flex-col gap-0.5">
                {sessions.map((s) => {
                  const active = s.id === activeSessionId;
                  return (
                    <li key={s.id} className="group relative">
                      <button
                        type="button"
                        onClick={() => openSession(s.id)}
                        title={s.title?.trim() || 'Untitled conversation'}
                        className={`w-full text-left rounded-lg py-2 pl-3 pr-9 transition-colors ${
                          active
                            ? 'bg-primary/10 text-on-surface'
                            : 'text-on-surface-variant hover:bg-surface-high/60 hover:text-on-surface'
                        }`}
                      >
                        <div className="text-xs truncate">
                          {s.title?.trim() || 'Untitled conversation'}
                        </div>
                        <div className="text-[10px] text-on-surface-variant/80">
                          {relativeTime(s.updatedAt ?? s.createdAt)}
                        </div>
                      </button>
                      <button
                        type="button"
                        onClick={(event) => {
                          event.stopPropagation();
                          void deleteSession(s.id);
                        }}
                        disabled={deletingSessionId === s.id}
                        className="absolute right-1.5 top-1/2 flex h-7 w-7 -translate-y-1/2 items-center justify-center rounded-md text-on-surface-variant opacity-0 transition hover:bg-surface-high hover:text-error focus:opacity-100 focus:outline-none focus:ring-2 focus:ring-error/30 disabled:cursor-not-allowed disabled:opacity-40 group-hover:opacity-100"
                        title="Delete conversation"
                        aria-label="Delete conversation"
                      >
                        <svg className="h-3.5 w-3.5" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth={1.8}>
                          <path strokeLinecap="round" strokeLinejoin="round" d="M7 5V4a2 2 0 012-2h2a2 2 0 012 2v1m-7 0h8m-9 0h10m-9 3v7m4-7v7m4-7v7M5 5l1 13h8l1-13" />
                        </svg>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </div>
      )}

      {/* Bottom account menu — low-frequency account/settings actions live
          behind the avatar instead of taking permanent sidebar space. */}
      <div className={`flex flex-col gap-1 mt-auto ${expanded ? '' : 'items-center'}`}>
        {/* User avatar — opens a small menu. Clicking the avatar itself used
            to sign the user out directly, which surprised everyone who
            expected a profile menu. Now it toggles a popover that contains
            the explicit Sign-out action. */}
        {user && (
          <UserMenu
            user={user}
            expanded={expanded}
            canSeeAdmin={canSeeAdmin}
            onLogout={() => void handleLogout()}
          />
        )}
      </div>
    </nav>
  );
}
