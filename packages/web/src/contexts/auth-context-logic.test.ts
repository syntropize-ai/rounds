/**
 * Unit tests for the pure logic embedded in AuthContext.
 *
 * The React provider itself requires a DOM (jsdom / happy-dom) that is not
 * installed in this workspace; these tests exercise the same helpers the
 * provider delegates to, giving us deterministic coverage of permission
 * evaluation and user DTO shaping.
 */

import { describe, it, expect } from 'vitest';
import {
  checkPermission,
  pickCurrentOrg,
  toAuthUser,
} from './AuthContext.js';
import type { CurrentUser } from '../api/client.js';

function makeUser(overrides: Partial<CurrentUser> = {}): CurrentUser {
  return {
    id: 'u1',
    email: 'alice@example.com',
    login: 'alice',
    name: 'Alice',
    theme: 'light',
    orgId: 'org_a',
    isGrafanaAdmin: false,
    orgs: [
      { orgId: 'org_a', name: 'A', role: 'Admin' },
      { orgId: 'org_b', name: 'B', role: 'Viewer' },
    ],
    authLabels: [],
    isDisabled: false,
    isExternal: false,
    ...overrides,
  };
}

describe('checkPermission', () => {
  it('returns false for an action the user does not have', () => {
    expect(checkPermission({}, 'dashboards:read')).toBe(false);
  });

  it('returns false when the action has an empty scope array', () => {
    expect(checkPermission({ 'dashboards:read': [] }, 'dashboards:read')).toBe(false);
  });

  it('returns true for an action without a required scope', () => {
    expect(
      checkPermission({ 'dashboards:read': ['dashboards:uid:x'] }, 'dashboards:read'),
    ).toBe(true);
  });

  it('treats empty stored scope as unrestricted', () => {
    expect(
      checkPermission({ 'dashboards:write': [''] }, 'dashboards:write', 'dashboards:uid:anything'),
    ).toBe(true);
  });

  it('matches exact scopes', () => {
    expect(
      checkPermission(
        { 'dashboards:write': ['dashboards:uid:a'] },
        'dashboards:write',
        'dashboards:uid:a',
      ),
    ).toBe(true);
  });

  it('rejects non-matching exact scopes', () => {
    expect(
      checkPermission(
        { 'dashboards:write': ['dashboards:uid:a'] },
        'dashboards:write',
        'dashboards:uid:b',
      ),
    ).toBe(false);
  });

  it('respects wildcard coverage via scopeCovers', () => {
    expect(
      checkPermission(
        { 'dashboards:write': ['dashboards:uid:*'] },
        'dashboards:write',
        'dashboards:uid:abc',
      ),
    ).toBe(true);
  });

  it('rejects wildcard mismatch across kinds', () => {
    expect(
      checkPermission(
        { 'folders:write': ['folders:uid:*'] },
        'folders:write',
        'dashboards:uid:abc',
      ),
    ).toBe(false);
  });
});

describe('toAuthUser', () => {
  it('renames isGrafanaAdmin → isServerAdmin', () => {
    const u = toAuthUser(makeUser({ isGrafanaAdmin: true }));
    expect(u.isServerAdmin).toBe(true);
    expect((u as unknown as Record<string, unknown>).isGrafanaAdmin).toBeUndefined();
  });

  it('copies core identity fields verbatim', () => {
    const u = toAuthUser(makeUser());
    expect(u.id).toBe('u1');
    expect(u.email).toBe('alice@example.com');
    expect(u.login).toBe('alice');
    expect(u.orgId).toBe('org_a');
  });
});

describe('pickCurrentOrg', () => {
  it('picks the org matching orgId', () => {
    const me = makeUser({ orgId: 'org_b' });
    const current = pickCurrentOrg(me);
    expect(current?.orgId).toBe('org_b');
    expect(current?.role).toBe('Viewer');
  });

  it('falls back to the first org when orgId is not present', () => {
    const me = makeUser({ orgId: 'org_missing' });
    const current = pickCurrentOrg(me);
    expect(current?.orgId).toBe('org_a');
  });

  it('returns null when the user has no orgs', () => {
    const me = makeUser({ orgs: [] });
    expect(pickCurrentOrg(me)).toBeNull();
  });
});
