/**
 * Admin page — tabbed shell that routes to sub-pages under /admin/<tab>.
 *
 * Implements the `<AdminLayout>` mandated by docs/auth-perm-design/09-frontend.md
 * §T8.3 – §T8.6: tabs gated by permission, server-admin-only Organizations tab,
 * audit log visibility controlled by `server.audit:read`.
 */

import React from 'react';
import { NavLink, Navigate, Route, Routes } from 'react-router-dom';
import { useHasPermission, useIsServerAdmin } from './admin/_gate.js';

const Users = React.lazy(() => import('./admin/Users.js'));
const ServiceAccounts = React.lazy(() => import('./admin/ServiceAccounts.js'));
const Teams = React.lazy(() => import('./admin/Teams.js'));
const Roles = React.lazy(() => import('./admin/Roles.js'));
const Orgs = React.lazy(() => import('./admin/Orgs.js'));
const OrgUsers = React.lazy(() => import('./admin/OrgUsers.js'));
const AuditLog = React.lazy(() => import('./admin/AuditLog.js'));

interface TabDef {
  to: string;
  label: string;
  visible: boolean;
}

export default function Admin(): React.ReactElement {
  const has = useHasPermission();
  const isServerAdmin = useIsServerAdmin();

  const canUsers = has('users:read') || has('org.users:read') || isServerAdmin;
  const canTeams = has('teams:read') || isServerAdmin;
  const canSA = has('serviceaccounts:read') || isServerAdmin;
  const canRoles = has('roles:read') || isServerAdmin;
  const canAudit = has('server.audit:read') || isServerAdmin;

  const tabs: TabDef[] = [
    { to: 'users', label: 'Users', visible: canUsers },
    { to: 'service-accounts', label: 'Service accounts', visible: canSA },
    { to: 'teams', label: 'Teams', visible: canTeams },
    { to: 'roles', label: 'Roles', visible: canRoles },
    { to: 'orgs', label: 'Organizations', visible: isServerAdmin },
    { to: 'audit-log', label: 'Audit log', visible: canAudit },
  ];

  const firstVisible = tabs.find((t) => t.visible);
  if (!firstVisible) {
    return (
      <div className="max-w-5xl mx-auto px-6 py-8">
        <h1 className="text-2xl font-bold text-on-surface">Administration</h1>
        <p className="text-on-surface-variant mt-2">
          You don't have permission to view any admin section.
        </p>
      </div>
    );
  }

  return (
    <div className="max-w-6xl mx-auto px-6 py-8">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-on-surface">Administration</h1>
        <p className="text-on-surface-variant mt-1">
          Manage users, teams, service accounts, roles, and organizations
        </p>
      </div>

      <div className="flex gap-1 mb-6 border-b border-outline overflow-x-auto">
        {tabs
          .filter((t) => t.visible)
          .map((t) => (
            <NavLink
              key={t.to}
              to={t.to}
              className={({ isActive }) =>
                `px-4 py-2.5 text-sm font-medium transition-colors border-b-2 -mb-px whitespace-nowrap ${
                  isActive
                    ? 'border-primary text-primary'
                    : 'border-transparent text-on-surface-variant hover:text-on-surface hover:border-outline-variant'
                }`
              }
            >
              {t.label}
            </NavLink>
          ))}
      </div>

      <React.Suspense
        fallback={
          <div className="py-12 text-center text-on-surface-variant text-sm">Loading…</div>
        }
      >
        <Routes>
          <Route index element={<Navigate to={firstVisible.to} replace />} />
          {canUsers && <Route path="users" element={<Users />} />}
          {canSA && <Route path="service-accounts" element={<ServiceAccounts />} />}
          {canTeams && <Route path="teams" element={<Teams />} />}
          {canRoles && <Route path="roles" element={<Roles />} />}
          {isServerAdmin && <Route path="orgs" element={<Orgs />} />}
          {isServerAdmin && <Route path="orgs/:id" element={<OrgUsers />} />}
          {canAudit && <Route path="audit-log" element={<AuditLog />} />}
          <Route path="*" element={<Navigate to={firstVisible.to} replace />} />
        </Routes>
      </React.Suspense>
    </div>
  );
}
