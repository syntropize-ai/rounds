import React, { useEffect, useState } from 'react';
import { NavLink, useNavigate } from 'react-router-dom';
import { apiClient } from '../api/client.js';
import { useAuth } from '../contexts/AuthContext.js';

interface NavigationProps {
  mobileNavOpen?: boolean;
  onToggleMobileNav?: () => void;
  onClose?: () => void;
}

function usePendingApprovals(): number {
  // Approval polling disabled — feature not yet active in UI.
  // Will be re-enabled when approval workflow is implemented.
  return 0;
}

function SettingsIcon() {
  return (
    <svg className="w-4 h-4" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
      <path d="M11.49 3.17c-.38-1.36-2.6-1.96-3.52-.94l-.29.32a1.65 1.65 0 01-1.97.31l-.4-.18c-1.2-.53-2.92.26-3.08 1.56l-.04.35c-.07.57-.4 1.08-.88 1.35l-.29.17c-1.14.66-1.14 2.31 0 2.98l.29.16c.49.28.81.79.88 1.36l.04.35c.16 1.3 1.87 2.09 3.08 1.56l.4-.18c.62-.27 1.33-.15 1.97.31l.29.32c.92 1.02 3.14.42 3.52-.94l.1-.36c.16-.55.61-.98 1.17-1.12l.34-.08c1.29-.3 1.83-2.02.96-3.08l-.22-.27a1.65 1.65 0 010-2.08l.22-.27c.87-1.06.33-2.78-.96-3.08l-.34-.08a1.65 1.65 0 01-1.17-1.12l-.1-.36zM8 10a2 2 0 100-4 2 2 0 000 4z" />
    </svg>
  );
}

function ConnectionsIcon() {
  return (
    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2} aria-hidden="true">
      <path strokeLinecap="round" strokeLinejoin="round" d="M8.5 14.5l7-7m-9 1H5a2 2 0 00-2 2v1.5m14-4H19a2 2 0 012 2V11m-4.5 8.5H19a2 2 0 002-2V16m-14 2H5a2 2 0 01-2-2v-1.5" />
    </svg>
  );
}

const navLinkClass = ({ isActive }: { isActive: boolean }) =>
  `px-3 py-1 rounded-lg text-sm font-medium transition-colors ${
    isActive
      ? 'text-[#6366F1] bg-[#6366F1]/10'
      : 'text-[#8888AA] hover:text-[#E8E8ED] hover:bg-[#1C1C2E]'
  }`;

const mobileNavLinkClass = ({ isActive }: { isActive: boolean }) =>
  `text-left flex items-center gap-3 p-3 rounded-lg text-sm font-medium transition-colors ${
    isActive
      ? 'text-[#6366F1] bg-[#6366F1]/10'
      : 'text-[#8888AA] hover:text-[#E8E8ED] hover:bg-[#1C1C2E]'
  }`;

export default function Navigation({ mobileNavOpen, onToggleMobileNav, onClose }: NavigationProps) {
  const pendingApprovals = usePendingApprovals();
  const navigate = useNavigate();
  const { user, logout, isAdmin } = useAuth();

  const handleLogout = async () => {
    await logout();
    navigate('/login', { replace: true });
  };

  const navLinks = [
    { to: '/', label: 'Home' },
    { to: '/dashboards', label: 'Dashboards' },
    { to: '/feed', label: 'Feed' },
    { to: '/investigate', label: 'Investigate' },
    { to: '/actions', label: 'Actions', badge: pendingApprovals > 0 ? pendingApprovals : undefined },
    { to: '/alerting', label: 'Alerting' },
    { to: '/connections', label: 'Connections' },
    { to: '/settings', label: 'Settings' },
    ...(isAdmin ? [{ to: '/admin', label: 'Admin' }] : []),
  ];

  return (
    <>
      <nav className="hidden md:flex items-center gap-1">
        {navLinks.map(({ to, label, badge }) => (
          <NavLink key={to} to={to} end={to === '/'} className={navLinkClass} aria-label={label}>
            <span className="relative inline-flex items-center">
              {label}
              {badge !== undefined && (
                <span className="absolute -top-1.5 -right-3 inline-flex items-center justify-center rounded-full bg-amber-500 text-white text-xs font-bold leading-none min-w-4 h-4 px-1">
                  {badge > 99 ? '99+' : badge}
                </span>
              )}
            </span>
          </NavLink>
        ))}

        {user && (
          <div className="ml-2 flex items-center gap-2 border-l border-[#2A2A3E] pl-3">
            {user.avatarUrl ? (
              <img src={user.avatarUrl} alt="" className="w-7 h-7 rounded-full" />
            ) : (
              <div className="w-7 h-7 rounded-full bg-[#6366F1]/20 flex items-center justify-center text-xs font-bold text-[#6366F1]">
                {user.name.charAt(0).toUpperCase()}
              </div>
            )}
            <button
              type="button"
              onClick={() => void handleLogout()}
              className="text-xs text-[#8888AA] hover:text-[#E8E8ED] transition-colors"
            >
              Sign out
            </button>
          </div>
        )}
      </nav>

      <button
        type="button"
        aria-label={mobileNavOpen ? 'Close menu' : 'Open menu'}
        aria-expanded={mobileNavOpen}
        onClick={onToggleMobileNav}
        className="md:hidden p-2 rounded-lg text-[#8888AA] hover:text-[#E8E8ED] hover:bg-[#1C1C2E] transition-colors"
      >
        {mobileNavOpen ? (
          <svg className="w-5 h-5" viewBox="0 0 20 20" fill="currentColor">
            <path fillRule="evenodd" d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z" clipRule="evenodd" />
          </svg>
        ) : (
          <svg className="w-5 h-5" viewBox="0 0 20 20" fill="currentColor">
            <path fillRule="evenodd" d="M3 5a1 1 0 011-1h12a1 1 0 110 2H4a1 1 0 01-1-1zm0 5a1 1 0 011-1h12a1 1 0 110 2H4a1 1 0 01-1-1zm1 4a1 1 0 100 2h12a1 1 0 100-2H4z" clipRule="evenodd" />
          </svg>
        )}
      </button>

      {mobileNavOpen && (
        <div className="md:hidden fixed inset-0 z-40 bg-[#0A0A0F] pt-16 px-4">
          <div className="space-y-2">
            {navLinks.map(({ to, label, badge }) => (
              <NavLink
                key={to}
                to={to}
                onClick={onClose}
                className={mobileNavLinkClass}
              >
                <span className="flex-1">{label}</span>
                {badge !== undefined && (
                  <span className="inline-flex items-center justify-center rounded-full bg-amber-500 text-white text-xs font-bold h-5 min-w-5 px-1.5">
                    {badge > 99 ? '99+' : badge}
                  </span>
                )}
              </NavLink>
            ))}

            {user && (
              <div className="border-t border-[#2A2A3E] mt-3 pt-3 flex items-center gap-3">
                {user.avatarUrl ? (
                  <img src={user.avatarUrl} alt="" className="w-8 h-8 rounded-full flex-shrink-0" />
                ) : (
                  <div className="w-8 h-8 rounded-full bg-[#6366F1]/20 flex items-center justify-center text-xs font-bold text-[#6366F1] flex-shrink-0">
                    {user.name.charAt(0).toUpperCase()}
                  </div>
                )}
                <div className="min-w-0">
                  <div className="text-sm font-medium text-[#E8E8ED] truncate">{user.name}</div>
                  <div className="text-xs text-[#8888AA] truncate capitalize">{user.role}</div>
                </div>
                <button
                  type="button"
                  onClick={() => void handleLogout()}
                  className="ml-auto text-sm text-[#8888AA] hover:text-[#E8E8ED] transition-colors"
                >
                  Sign out
                </button>
              </div>
            )}
          </div>
        </div>
      )}
    </>
  );
}
