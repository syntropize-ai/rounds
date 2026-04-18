/**
 * OrgSwitcher — top-nav dropdown for switching the active organization.
 *
 * Hidden when the signed-in user belongs to a single org. Server admins
 * additionally see a "Manage organizations" footer link to /admin/orgs.
 *
 * See docs/auth-perm-design/09-frontend.md §T8.2.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext.js';
import type { OrgRole } from '@agentic-obs/common';

function OrgIcon({ className }: { className?: string }) {
  return (
    <svg className={className ?? 'w-4 h-4'} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M3 21h18M5 21V7l7-4 7 4v14M9 9h1m-1 4h1m-1 4h1m4-8h1m-1 4h1m-1 4h1" />
    </svg>
  );
}

function ChevronIcon({ className }: { className?: string }) {
  return (
    <svg className={className ?? 'w-3.5 h-3.5'} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M6 9l6 6 6-6" />
    </svg>
  );
}

function CheckIcon({ className }: { className?: string }) {
  return (
    <svg className={className ?? 'w-4 h-4'} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M5 12l5 5L20 7" />
    </svg>
  );
}

const ROLE_LABEL: Record<OrgRole, string> = {
  Admin: 'Admin',
  Editor: 'Editor',
  Viewer: 'Viewer',
  None: 'None',
};

function RoleBadge({ role }: { role: OrgRole }) {
  return (
    <span className="inline-flex items-center rounded-md bg-surface-high text-on-surface-variant text-[10px] font-semibold uppercase tracking-wide px-1.5 py-0.5 border border-outline-variant">
      {ROLE_LABEL[role] ?? role}
    </span>
  );
}

/**
 * Decides whether the switcher should be rendered at all. The design doc
 * hides the menu entirely for users with zero or one org.
 * Exported for unit tests.
 */
export function shouldRenderOrgSwitcher(orgs: { orgId: string }[] | null | undefined): boolean {
  if (!orgs) return false;
  return orgs.length > 1;
}

export interface OrgSwitcherProps {
  /** Optional visual compaction for narrow nav bars. */
  compact?: boolean;
}

export function OrgSwitcher({ compact = false }: OrgSwitcherProps) {
  const { user, currentOrg, orgs, isServerAdmin, switchOrg } = useAuth();
  const [open, setOpen] = useState(false);
  const [switching, setSwitching] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);

  // Close on outside click.
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  const onSelect = useCallback(
    async (orgId: string) => {
      if (!currentOrg || orgId === currentOrg.orgId) {
        setOpen(false);
        return;
      }
      setSwitching(orgId);
      setError(null);
      try {
        await switchOrg(orgId);
        setOpen(false);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to switch organization');
      } finally {
        setSwitching(null);
      }
    },
    [currentOrg, switchOrg],
  );

  // Hidden entirely when user has zero or one org.
  if (!user || !currentOrg || orgs.length <= 1) return null;

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className={`flex items-center gap-2 rounded-lg border border-outline-variant bg-surface-low text-on-surface hover:bg-surface-high transition-colors ${
          compact ? 'px-2.5 py-1.5 text-xs' : 'px-3 py-2 text-sm'
        }`}
      >
        <OrgIcon className={compact ? 'w-3.5 h-3.5' : 'w-4 h-4'} />
        <span className="font-medium truncate max-w-[160px]">{currentOrg.name}</span>
        <ChevronIcon />
      </button>

      {open && (
        <div
          role="menu"
          className="absolute left-0 top-full mt-2 w-72 rounded-xl border border-outline-variant bg-surface shadow-lg z-50 overflow-hidden"
        >
          <div className="px-3 py-2 text-[10px] font-semibold uppercase tracking-wide text-on-surface-variant border-b border-outline-variant">
            Organizations
          </div>
          <ul className="max-h-80 overflow-auto py-1">
            {orgs.map((org) => {
              const active = org.orgId === currentOrg.orgId;
              const isSwitching = switching === org.orgId;
              return (
                <li key={org.orgId}>
                  <button
                    type="button"
                    role="menuitemradio"
                    aria-checked={active}
                    disabled={switching !== null}
                    onClick={() => void onSelect(org.orgId)}
                    className={`w-full flex items-center justify-between gap-3 px-3 py-2 text-sm text-left transition-colors ${
                      active
                        ? 'bg-primary/10 text-primary'
                        : 'text-on-surface hover:bg-surface-high'
                    } disabled:opacity-60`}
                  >
                    <span className="flex items-center gap-2 min-w-0">
                      {active ? (
                        <CheckIcon className="w-4 h-4 shrink-0" />
                      ) : (
                        <span className="w-4 h-4 shrink-0" aria-hidden />
                      )}
                      <span className="truncate font-medium">{org.name}</span>
                    </span>
                    <span className="flex items-center gap-2 shrink-0">
                      <RoleBadge role={org.role} />
                      {isSwitching && (
                        <span
                          aria-label="Switching"
                          className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-on-surface-variant border-t-transparent"
                        />
                      )}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
          {error && (
            <div className="px-3 py-2 text-xs text-error border-t border-outline-variant">
              {error}
            </div>
          )}
          {isServerAdmin && (
            <div className="border-t border-outline-variant">
              <Link
                to="/admin/orgs"
                onClick={() => setOpen(false)}
                className="block px-3 py-2 text-sm text-primary hover:bg-surface-high"
              >
                Manage organizations
              </Link>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default OrgSwitcher;
