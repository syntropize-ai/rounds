/**
 * Shared helpers for the admin sub-pages (T8.3 – T8.6).
 *
 * These helpers are framework-independent (pure functions, plain types) so they
 * can be unit-tested without a DOM. Page components import types + URL builders
 * from here and focus on render logic only.
 *
 * Endpoints referenced match docs/auth-perm-design/08-api-surface.md. Strings are
 * operator-facing interface vocabulary (see §99 license hygiene).
 */

// ────────────────────────────────────────────────────────────────────────────
// DTO shapes — intentionally a subset of the full Grafana DTO. We type the
// fields the admin UI actually reads; unknown fields are tolerated.
// ────────────────────────────────────────────────────────────────────────────

export interface OrgUserDTO {
  userId: string;
  orgId: string;
  email: string;
  name: string;
  login: string;
  role: 'Admin' | 'Editor' | 'Viewer' | 'None' | string;
  avatarUrl?: string;
  lastSeenAt?: string | null;
  lastSeenAtAge?: string | null;
  isDisabled?: boolean;
  authLabels?: string[];
}

export interface AdminUserDTO {
  id: string;
  email: string;
  name: string;
  login: string;
  isAdmin?: boolean;
  isGrafanaAdmin?: boolean;
  isDisabled?: boolean;
  authLabels?: string[];
  lastSeenAt?: string | null;
  createdAt?: string;
  updatedAt?: string;
  avatarUrl?: string;
}

export interface ServiceAccountDTO {
  id: string;
  orgId: string;
  name: string;
  login: string;
  role: string;
  isDisabled: boolean;
  tokens: number;
  createdAt?: string;
  updatedAt?: string;
  avatarUrl?: string;
}

export interface ServiceAccountTokenDTO {
  id: string;
  name: string;
  hasExpired: boolean;
  expiration?: string | null;
  created?: string;
  lastUsedAt?: string | null;
}

export interface TeamDTO {
  id: string;
  orgId: string;
  name: string;
  email?: string | null;
  memberCount: number;
  isExternal?: boolean;
  external?: boolean;
  createdAt?: string;
}

export interface TeamMemberDTO {
  userId: string;
  teamId: string;
  email: string;
  login: string;
  name: string;
  /** Grafana permission bitmask: 0=Member, 4=Admin. */
  permission: 0 | 4 | number;
  avatarUrl?: string;
}

export interface RoleDTO {
  uid: string;
  name: string;
  displayName?: string;
  description?: string;
  group?: string;
  version?: number;
  hidden?: boolean;
  orgId?: string;
  global?: boolean;
  permissions?: Array<{ action: string; scope?: string }>;
  /** Number of principals (users+teams) assigned — server may omit. */
  assignments?: number;
}

export interface OrgDTO {
  id: string;
  name: string;
  created?: string;
  updated?: string;
  userCount?: number;
}

export interface AuditLogEntryDTO {
  id: string;
  timestamp: string;
  action: string;
  actorId?: string | null;
  actorLogin?: string | null;
  targetId?: string | null;
  targetLogin?: string | null;
  outcome: string;
  ip?: string | null;
  userAgent?: string | null;
  metadata?: Record<string, unknown> | null;
}

export interface PagedResponse<T> {
  items?: T[];
  totalCount?: number;
  total?: number;
  page?: number;
  perPage?: number;
  perpage?: number;
}

// ────────────────────────────────────────────────────────────────────────────
// URL builders — pure, heavily tested, no network calls.
// ────────────────────────────────────────────────────────────────────────────

export interface PagedQuery {
  query?: string;
  page?: number;
  perpage?: number;
}

/**
 * Serialize a flat record of query params, dropping null/undefined/empty string
 * values so callers don't need to branch at every call-site.
 */
export function buildQuery(params: Record<string, string | number | null | undefined>): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(params)) {
    if (value === null || value === undefined) continue;
    if (typeof value === 'string' && value.length === 0) continue;
    parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`);
  }
  return parts.length > 0 ? `?${parts.join('&')}` : '';
}

export function usersListUrl(mode: 'org' | 'admin', q: PagedQuery): string {
  const base = mode === 'admin' ? '/admin/users' : '/org/users';
  return `${base}${buildQuery({ query: q.query, page: q.page, perpage: q.perpage })}`;
}

export function serviceAccountsUrl(q: PagedQuery & { disabled?: boolean }): string {
  return `/serviceaccounts/search${buildQuery({
    query: q.query,
    page: q.page,
    perpage: q.perpage,
    disabled: q.disabled === undefined ? undefined : q.disabled ? 'true' : 'false',
  })}`;
}

export function teamsSearchUrl(q: PagedQuery): string {
  return `/teams/search${buildQuery({ query: q.query, page: q.page, perpage: q.perpage })}`;
}

export function rolesListUrl(includeHidden: boolean): string {
  return `/access-control/roles${buildQuery({ includeHidden: includeHidden ? 'true' : undefined })}`;
}

export function orgsListUrl(q: PagedQuery): string {
  return `/orgs${buildQuery({ query: q.query, page: q.page, perpage: q.perpage })}`;
}

export interface AuditLogQuery extends PagedQuery {
  action?: string;
  actorId?: string;
  targetId?: string;
  outcome?: string;
  from?: string;
  to?: string;
}

export function auditLogUrl(q: AuditLogQuery): string {
  return `/admin/audit-log${buildQuery({
    query: q.query,
    page: q.page,
    perpage: q.perpage,
    action: q.action,
    actorId: q.actorId,
    targetId: q.targetId,
    outcome: q.outcome,
    from: q.from,
    to: q.to,
  })}`;
}

// ────────────────────────────────────────────────────────────────────────────
// Classification helpers
// ────────────────────────────────────────────────────────────────────────────

/**
 * Classify a role UID into its bucket. `basic:*` → built-in; `fixed:*` → fixed;
 * `custom:*` or anything else → custom. Mirrors the three sub-tabs in Roles.
 */
export function classifyRole(uid: string): 'built-in' | 'fixed' | 'custom' {
  if (uid.startsWith('basic:')) return 'built-in';
  if (uid.startsWith('fixed:')) return 'fixed';
  return 'custom';
}

/**
 * True iff `name` is a legal custom-role name client-side: must start with
 * `custom:` and contain at least one character after the prefix.
 */
export function isValidCustomRoleName(name: string): boolean {
  if (!name.startsWith('custom:')) return false;
  return name.length > 'custom:'.length;
}

/** Human label for a Grafana-style team permission bitmask. */
export function teamPermissionLabel(permission: number): 'Admin' | 'Member' {
  return permission >= 4 ? 'Admin' : 'Member';
}

/**
 * Translate the expiry selector used in the create-token modal into a
 * `secondsToLive` value for `POST /serviceaccounts/:id/tokens`.
 * `null` means the token never expires (Grafana convention).
 */
export function expiryToSeconds(
  choice: 'never' | '30d' | '90d' | '365d' | 'custom',
  customDays?: number,
): number | null {
  switch (choice) {
    case 'never':
      return null;
    case '30d':
      return 30 * 24 * 3600;
    case '90d':
      return 90 * 24 * 3600;
    case '365d':
      return 365 * 24 * 3600;
    case 'custom':
      if (!customDays || customDays <= 0) return null;
      return Math.round(customDays * 24 * 3600);
  }
}

/**
 * Best-effort auth method badge from `authLabels`. Falls back to 'local'.
 */
export function authMethodLabel(labels?: string[]): string {
  if (!labels || labels.length === 0) return 'local';
  const first = labels[0]!.toLowerCase();
  if (first.includes('github')) return 'github';
  if (first.includes('google')) return 'google';
  if (first.includes('ldap')) return 'ldap';
  if (first.includes('saml')) return 'saml';
  if (first.includes('oauth')) return 'oauth';
  if (first.includes('password') || first.includes('local')) return 'local';
  return labels[0]!;
}

/**
 * Format a last-seen ISO timestamp as a short relative duration. Undefined /
 * null → 'never'.
 */
export function formatLastSeen(iso?: string | null, now: Date = new Date()): string {
  if (!iso) return 'never';
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return 'unknown';
  const diffMs = now.getTime() - then;
  if (diffMs < 0) return 'just now';
  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo ago`;
  const years = Math.floor(days / 365);
  return `${years}y ago`;
}
