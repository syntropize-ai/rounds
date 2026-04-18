/**
 * Unit tests for the shared admin helpers. These stay DOM-free so they run
 * under the default `environment: 'node'` vitest config — packages/web does
 * not currently ship jsdom/happy-dom.
 */

import { describe, expect, it } from 'vitest';
import {
  authMethodLabel,
  auditLogUrl,
  buildQuery,
  classifyRole,
  expiryToSeconds,
  formatLastSeen,
  isValidCustomRoleName,
  orgsListUrl,
  rolesListUrl,
  serviceAccountsUrl,
  teamPermissionLabel,
  teamsSearchUrl,
  usersListUrl,
} from '../_shared.js';

describe('buildQuery', () => {
  it('returns empty string when all values are absent', () => {
    expect(buildQuery({})).toBe('');
    expect(buildQuery({ a: undefined, b: null, c: '' })).toBe('');
  });

  it('includes only defined non-empty values and url-encodes', () => {
    expect(buildQuery({ query: 'a b', page: 2, perpage: 20 })).toBe(
      '?query=a%20b&page=2&perpage=20',
    );
  });

  it('preserves numeric zero', () => {
    expect(buildQuery({ page: 0 })).toBe('?page=0');
  });
});

describe('list url builders', () => {
  it('usersListUrl targets /admin/users for cross-org view', () => {
    expect(usersListUrl('admin', { query: 'al', page: 1, perpage: 20 })).toBe(
      '/admin/users?query=al&page=1&perpage=20',
    );
  });

  it('usersListUrl targets /org/users by default', () => {
    expect(usersListUrl('org', {})).toBe('/org/users');
  });

  it('serviceAccountsUrl serializes the disabled filter as a string', () => {
    expect(serviceAccountsUrl({ disabled: true })).toBe('/serviceaccounts/search?disabled=true');
    expect(serviceAccountsUrl({ disabled: false })).toBe('/serviceaccounts/search?disabled=false');
    expect(serviceAccountsUrl({})).toBe('/serviceaccounts/search');
  });

  it('teamsSearchUrl builds a paged search path', () => {
    expect(teamsSearchUrl({ query: 'sre', page: 2 })).toBe('/teams/search?query=sre&page=2');
  });

  it('rolesListUrl opts into includeHidden only when true', () => {
    expect(rolesListUrl(true)).toBe('/access-control/roles?includeHidden=true');
    expect(rolesListUrl(false)).toBe('/access-control/roles');
  });

  it('orgsListUrl builds a paged search path', () => {
    expect(orgsListUrl({ query: 'acme' })).toBe('/orgs?query=acme');
  });

  it('auditLogUrl omits absent filters', () => {
    expect(auditLogUrl({ action: 'user.login', from: '2026-01-01', outcome: 'success' })).toBe(
      '/admin/audit-log?action=user.login&outcome=success&from=2026-01-01',
    );
  });
});

describe('classifyRole', () => {
  it('splits role uids into built-in / fixed / custom', () => {
    expect(classifyRole('basic:viewer')).toBe('built-in');
    expect(classifyRole('fixed:dashboards:writer')).toBe('fixed');
    expect(classifyRole('custom:sre-writer')).toBe('custom');
    expect(classifyRole('something-else')).toBe('custom');
  });
});

describe('isValidCustomRoleName', () => {
  it('requires a custom: prefix and at least one more character', () => {
    expect(isValidCustomRoleName('custom:a')).toBe(true);
    expect(isValidCustomRoleName('custom:')).toBe(false);
    expect(isValidCustomRoleName('fixed:a')).toBe(false);
    expect(isValidCustomRoleName('')).toBe(false);
  });
});

describe('teamPermissionLabel', () => {
  it('maps the Grafana permission bitmask', () => {
    expect(teamPermissionLabel(0)).toBe('Member');
    expect(teamPermissionLabel(4)).toBe('Admin');
    expect(teamPermissionLabel(99)).toBe('Admin');
  });
});

describe('expiryToSeconds', () => {
  it('handles the preset choices', () => {
    expect(expiryToSeconds('never')).toBe(null);
    expect(expiryToSeconds('30d')).toBe(30 * 86400);
    expect(expiryToSeconds('90d')).toBe(90 * 86400);
    expect(expiryToSeconds('365d')).toBe(365 * 86400);
  });

  it('handles custom day counts', () => {
    expect(expiryToSeconds('custom', 7)).toBe(7 * 86400);
    expect(expiryToSeconds('custom', 0)).toBe(null);
    expect(expiryToSeconds('custom')).toBe(null);
  });
});

describe('authMethodLabel', () => {
  it('defaults to local when no labels provided', () => {
    expect(authMethodLabel()).toBe('local');
    expect(authMethodLabel([])).toBe('local');
  });

  it('matches provider keywords case-insensitively', () => {
    expect(authMethodLabel(['OAuth GitHub'])).toBe('github');
    expect(authMethodLabel(['oauth google'])).toBe('google');
    expect(authMethodLabel(['LDAP'])).toBe('ldap');
    expect(authMethodLabel(['SAML'])).toBe('saml');
    expect(authMethodLabel(['Password'])).toBe('local');
  });

  it('returns the raw label as a fallback', () => {
    expect(authMethodLabel(['custom-thing'])).toBe('custom-thing');
  });
});

describe('formatLastSeen', () => {
  const now = new Date('2026-04-17T12:00:00Z');

  it('returns never when missing', () => {
    expect(formatLastSeen(null, now)).toBe('never');
    expect(formatLastSeen(undefined, now)).toBe('never');
  });

  it('formats into a coarse relative duration', () => {
    expect(formatLastSeen('2026-04-17T11:59:30Z', now)).toBe('just now');
    expect(formatLastSeen('2026-04-17T11:55:00Z', now)).toBe('5 min ago');
    expect(formatLastSeen('2026-04-17T09:00:00Z', now)).toBe('3h ago');
    expect(formatLastSeen('2026-04-10T12:00:00Z', now)).toBe('7d ago');
    expect(formatLastSeen('2026-01-01T12:00:00Z', now)).toBe('3mo ago');
    expect(formatLastSeen('2023-04-17T12:00:00Z', now)).toBe('3y ago');
  });

  it('reports unknown for bad timestamps', () => {
    expect(formatLastSeen('not-a-date', now)).toBe('unknown');
  });
});
