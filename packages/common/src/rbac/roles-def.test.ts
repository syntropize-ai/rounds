import { describe, expect, it } from 'vitest';
import {
  BASIC_ROLE_DEFINITIONS,
  resolveBasicRolePermissions,
} from './roles-def.js';
import { FIXED_ROLE_DEFINITIONS, findFixedRole } from './fixed-roles-def.js';
import { ALL_ACTIONS } from './actions.js';

describe('basic role definitions', () => {
  it('defines exactly 4 basic roles', () => {
    expect(BASIC_ROLE_DEFINITIONS.length).toBe(4);
  });

  it('names are basic:viewer / editor / admin / server_admin', () => {
    const names = BASIC_ROLE_DEFINITIONS.map((d) => d.name).sort();
    expect(names).toEqual([
      'basic:admin',
      'basic:editor',
      'basic:server_admin',
      'basic:viewer',
    ]);
  });

  it('server_admin is global, others are org-scoped', () => {
    for (const d of BASIC_ROLE_DEFINITIONS) {
      if (d.name === 'basic:server_admin') expect(d.global).toBe(true);
      else expect(d.global).toBe(false);
    }
  });

  it('basic:server_admin grants every action in the catalog', () => {
    const perms = resolveBasicRolePermissions('basic:server_admin');
    const granted = new Set(perms.map((p) => p.action));
    for (const a of ALL_ACTIONS) expect(granted.has(a)).toBe(true);
  });

  it('basic:editor inherits every viewer permission', () => {
    const viewer = resolveBasicRolePermissions('basic:viewer');
    const editor = resolveBasicRolePermissions('basic:editor');
    const editorKeys = new Set(editor.map((p) => `${p.action}|${p.scope}`));
    for (const v of viewer) {
      expect(editorKeys.has(`${v.action}|${v.scope}`)).toBe(true);
    }
  });

  it('basic:admin inherits every editor permission', () => {
    const editor = resolveBasicRolePermissions('basic:editor');
    const admin = resolveBasicRolePermissions('basic:admin');
    const adminKeys = new Set(admin.map((p) => `${p.action}|${p.scope}`));
    for (const e of editor) {
      expect(adminKeys.has(`${e.action}|${e.scope}`)).toBe(true);
    }
  });

  it('viewer permissions are roughly ~20+ and editor/admin grow from there', () => {
    const v = resolveBasicRolePermissions('basic:viewer').length;
    const e = resolveBasicRolePermissions('basic:editor').length;
    const a = resolveBasicRolePermissions('basic:admin').length;
    expect(v).toBeGreaterThan(10);
    expect(e).toBeGreaterThan(v);
    expect(a).toBeGreaterThan(e);
  });
});

describe('fixed role definitions', () => {
  it('has between 40 and 100 roles (Grafana v11.3.0 + openobs extensions)', () => {
    expect(FIXED_ROLE_DEFINITIONS.length).toBeGreaterThanOrEqual(40);
    expect(FIXED_ROLE_DEFINITIONS.length).toBeLessThanOrEqual(100);
  });

  it('every fixed role name starts with "fixed:"', () => {
    for (const r of FIXED_ROLE_DEFINITIONS) {
      expect(r.name.startsWith('fixed:')).toBe(true);
    }
  });

  it('names are unique', () => {
    const set = new Set(FIXED_ROLE_DEFINITIONS.map((r) => r.name));
    expect(set.size).toBe(FIXED_ROLE_DEFINITIONS.length);
  });

  it('uids are unique and mirror the name shape (with : -> _)', () => {
    for (const r of FIXED_ROLE_DEFINITIONS) {
      expect(r.uid).toMatch(/^fixed_[a-z_.]+$/);
    }
    const uids = new Set(FIXED_ROLE_DEFINITIONS.map((r) => r.uid));
    expect(uids.size).toBe(FIXED_ROLE_DEFINITIONS.length);
  });

  it('each role has at least one permission', () => {
    for (const r of FIXED_ROLE_DEFINITIONS) {
      expect(r.permissions.length).toBeGreaterThan(0);
    }
  });

  it('covers the canonical kinds called out in the design doc', () => {
    const required = [
      'fixed:dashboards:reader',
      'fixed:dashboards:writer',
      'fixed:folders:reader',
      'fixed:folders:writer',
      'fixed:folders:creator',
      'fixed:connectors:reader',
      'fixed:connectors:writer',
      'fixed:connectors:explorer',
      'fixed:users:reader',
      'fixed:users:writer',
      'fixed:teams:reader',
      'fixed:teams:writer',
      'fixed:teams:creator',
      'fixed:serviceaccounts:reader',
      'fixed:serviceaccounts:writer',
      'fixed:serviceaccounts:creator',
      'fixed:orgs:reader',
      'fixed:orgs:writer',
      'fixed:orgs:creator',
      'fixed:roles:reader',
      'fixed:roles:writer',
      'fixed:annotations:reader',
      'fixed:annotations:writer',
      'fixed:alert.rules:reader',
      'fixed:alert.rules:writer',
      'fixed:alert.instances:reader',
      'fixed:alert.silences:creator',
      'fixed:alert.silences:writer',
      'fixed:alert.provisioning:reader',
      'fixed:alert.provisioning:writer',
      'fixed:server.stats:reader',
      'fixed:server.usagestats.report:reader',
    ];
    for (const name of required) {
      expect(findFixedRole(name), `missing role ${name}`).toBeDefined();
    }
  });

  it('findFixedRole returns undefined for unknown names', () => {
    expect(findFixedRole('fixed:bogus:role')).toBeUndefined();
  });
});
