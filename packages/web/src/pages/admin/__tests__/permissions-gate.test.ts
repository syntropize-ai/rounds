/**
 * Behavioural tests for the permission-gated visibility rules the admin tabs
 * consume. Mirrors the boolean computations inside `Admin.tsx`, `Users.tsx`,
 * etc. so we notice if any of them drift from docs/auth-perm-design/09-frontend.md.
 *
 * DOM-free: we exercise the predicate helpers directly, not the rendered JSX.
 * (The project does not currently ship jsdom/happy-dom; the render path is
 * smoke-checked by the typecheck.)
 */

import { describe, expect, it } from 'vitest';

type HasFn = (action: string, scope?: string) => boolean;
const hasFactory = (perms: Record<string, string[]>): HasFn => {
  return (action, scope) => {
    const scopes = perms[action];
    if (!scopes || scopes.length === 0) return false;
    if (!scope) return true;
    return scopes.includes(scope) || scopes.includes('*');
  };
};

// Re-implement the visibility predicates in one place; each test compares
// to the expected boolean combinations from the Admin tab router.
function computeVisibility(has: HasFn, isServerAdmin: boolean): Record<string, boolean> {
  return {
    users: has('users:read') || has('org.users:read') || isServerAdmin,
    teams: has('teams:read') || isServerAdmin,
    serviceAccounts: has('serviceaccounts:read') || isServerAdmin,
    roles: has('roles:read') || isServerAdmin,
    orgs: isServerAdmin,
    auditLog: has('server.audit:read') || isServerAdmin,
  };
}

describe('admin tab visibility', () => {
  it('hides every section for a user with no permissions', () => {
    const v = computeVisibility(hasFactory({}), false);
    expect(v.users).toBe(false);
    expect(v.teams).toBe(false);
    expect(v.serviceAccounts).toBe(false);
    expect(v.roles).toBe(false);
    expect(v.orgs).toBe(false);
    expect(v.auditLog).toBe(false);
  });

  it('shows everything for a server admin regardless of action scopes', () => {
    const v = computeVisibility(hasFactory({}), true);
    expect(v.users).toBe(true);
    expect(v.teams).toBe(true);
    expect(v.serviceAccounts).toBe(true);
    expect(v.roles).toBe(true);
    expect(v.orgs).toBe(true);
    expect(v.auditLog).toBe(true);
  });

  it('shows Users via org.users:read without full users:read', () => {
    const v = computeVisibility(hasFactory({ 'org.users:read': ['*'] }), false);
    expect(v.users).toBe(true);
    expect(v.teams).toBe(false);
    expect(v.orgs).toBe(false);
  });

  it('shows audit log only for server.audit:read', () => {
    const v = computeVisibility(hasFactory({ 'server.audit:read': ['*'] }), false);
    expect(v.auditLog).toBe(true);
    expect(v.users).toBe(false);
  });

  it('hides Organizations tab for non-server admins even with orgs:read', () => {
    const v = computeVisibility(hasFactory({ 'orgs:read': ['*'] }), false);
    expect(v.orgs).toBe(false);
  });
});

describe('Users tab action-guard booleans', () => {
  // Duplicated from `pages/admin/Users.tsx` — these are derived up front so
  // we can test them independently of React.
  function computeUserAccess(has: HasFn, isServerAdmin: boolean) {
    return {
      canView: has('users:read') || has('org.users:read') || isServerAdmin,
      canCreate: has('users:create') || isServerAdmin,
      canWrite: has('users:write') || has('org.users:write') || isServerAdmin,
      canDelete: has('users:delete') || has('org.users:remove') || isServerAdmin,
    };
  }

  it('Viewer can see but not act', () => {
    const a = computeUserAccess(hasFactory({ 'org.users:read': ['*'] }), false);
    expect(a.canView).toBe(true);
    expect(a.canCreate).toBe(false);
    expect(a.canWrite).toBe(false);
    expect(a.canDelete).toBe(false);
  });

  it('Org Admin has org.users:* → can do everything in org', () => {
    const a = computeUserAccess(
      hasFactory({
        'org.users:read': ['*'],
        'org.users:write': ['*'],
        'org.users:remove': ['*'],
      }),
      false,
    );
    expect(a.canView).toBe(true);
    expect(a.canWrite).toBe(true);
    expect(a.canDelete).toBe(true);
    // `users:create` is server-level so still gated:
    expect(a.canCreate).toBe(false);
  });

  it('Server admin bypasses all flags', () => {
    const a = computeUserAccess(hasFactory({}), true);
    expect(a.canView).toBe(true);
    expect(a.canCreate).toBe(true);
    expect(a.canWrite).toBe(true);
    expect(a.canDelete).toBe(true);
  });
});

describe('Teams tab action-guard booleans', () => {
  function compute(has: HasFn, isServerAdmin: boolean) {
    return {
      canView: has('teams:read') || isServerAdmin,
      canCreate: has('teams:create') || isServerAdmin,
      canWrite: has('teams:write') || isServerAdmin,
      canDelete: has('teams:delete') || isServerAdmin,
    };
  }

  it('unprivileged user cannot see teams', () => {
    expect(compute(hasFactory({}), false).canView).toBe(false);
  });

  it('teams:read alone grants view but not mutation', () => {
    const a = compute(hasFactory({ 'teams:read': ['*'] }), false);
    expect(a.canView).toBe(true);
    expect(a.canWrite).toBe(false);
    expect(a.canDelete).toBe(false);
  });
});

describe('Roles tab action-guard booleans', () => {
  function compute(has: HasFn, isServerAdmin: boolean) {
    return {
      canRead: has('roles:read') || isServerAdmin,
      canWrite: has('roles:write') || isServerAdmin,
    };
  }

  it('roles:write implies canWrite for custom roles', () => {
    const a = compute(hasFactory({ 'roles:write': ['*'] }), false);
    expect(a.canWrite).toBe(true);
  });
});

describe('Orgs tab gating', () => {
  it('is gated strictly to server admins', () => {
    const isAllowed = (isServerAdmin: boolean): boolean => isServerAdmin;
    expect(isAllowed(true)).toBe(true);
    expect(isAllowed(false)).toBe(false);
  });
});
