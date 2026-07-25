import { useEffect } from 'react';
import { useLocation } from 'react-router-dom';

/**
 * Route-level document titles. Every tab used to read "Rounds" because the
 * app never touched `document.title` after the initial index.html render,
 * which made a handful of open Rounds tabs indistinguishable.
 *
 * Kept as a plain path → name table rather than a meta library: the route
 * set lives in App.tsx (plus the admin sub-routes in pages/Admin.tsx) and
 * is small enough to enumerate.
 */

const SUFFIX = 'Rounds';

const EXACT: Record<string, string> = {
  '/': 'Home',
  '/login': 'Sign in',
  '/login/callback': 'Sign in',
  '/setup': 'Setup',
  '/feed': 'Feed',
  '/investigations': 'Investigations',
  '/actions': 'Action Center',
  '/settings': 'Settings',
  '/dashboards': 'Dashboards',
  '/alerts': 'Alerts',
  '/admin': 'Admin',
  '/admin/users': 'Users',
  '/admin/service-accounts': 'Service Accounts',
  '/admin/teams': 'Teams',
  '/admin/roles': 'Roles',
  '/admin/orgs': 'Organizations',
  '/admin/audit-log': 'Audit Log',
};

const PATTERNS: Array<[RegExp, string]> = [
  [/^\/investigations\/[^/]+$/, 'Investigation'],
  [/^\/evidence\/[^/]+$/, 'Evidence'],
  [/^\/plans\/[^/]+$/, 'Review Fix'],
  [/^\/dashboards\/[^/]+$/, 'Dashboard'],
  [/^\/alerts\/[^/]+\/edit$/, 'Edit Alert Rule'],
  [/^\/admin\/orgs\/[^/]+$/, 'Organization Members'],
];

/** "<Page> · Rounds", or bare "Rounds" for a path with no page behind it. */
export function titleForPath(pathname: string): string {
  const path = pathname.length > 1 ? pathname.replace(/\/+$/, '') : pathname;
  const exact = EXACT[path];
  if (exact) return `${exact} · ${SUFFIX}`;
  const matched = PATTERNS.find(([pattern]) => pattern.test(path));
  if (matched) return `${matched[1]} · ${SUFFIX}`;
  return SUFFIX;
}

/** Keep `document.title` in sync with the active route. */
export function useRouteTitle(): void {
  const { pathname } = useLocation();
  useEffect(() => {
    document.title = titleForPath(pathname);
  }, [pathname]);
}
