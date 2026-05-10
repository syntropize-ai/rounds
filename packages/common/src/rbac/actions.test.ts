import { describe, expect, it } from 'vitest';
import { ACTIONS, ALL_ACTIONS, isKnownAction, type RbacAction } from './actions.js';

describe('rbac/actions catalog', () => {
  it('exposes at least 90 actions (parity with Grafana v11.3.0 + openobs extensions)', () => {
    expect(ALL_ACTIONS.length).toBeGreaterThanOrEqual(90);
  });

  it('values are unique (no accidental duplicates)', () => {
    const set = new Set(ALL_ACTIONS as readonly string[]);
    expect(set.size).toBe(ALL_ACTIONS.length);
  });

  it('all action strings are non-empty and shaped kind[.sub]:verb', () => {
    for (const a of ALL_ACTIONS) {
      expect(a.length).toBeGreaterThan(0);
      // Every action must contain a ":" separating kind from verb (except none).
      expect(a).toMatch(/^[a-z][a-z0-9.]*:[a-z][a-z0-9_]*$/);
    }
  });

  it('includes every category from the design doc', () => {
    const categories = [
      'dashboards:read',
      'folders:read',
      'connectors:read',
      'alert.rules:read',
      'users:read',
      'org.users:read',
      'orgs:read',
      'teams:read',
      'serviceaccounts:read',
      'apikeys:read',
      'roles:read',
      'server.stats:read',
      'annotations:read',
      // openobs extensions
      'investigations:read',
      'approvals:read',
      'chat:use',
      'agents.config:read',
      'connectors:read',
      'ops.commands:run',
    ];
    for (const a of categories) {
      expect(ALL_ACTIONS).toContain(a as RbacAction);
    }
  });

  it('isKnownAction narrows type for valid strings', () => {
    expect(isKnownAction('dashboards:read')).toBe(true);
    expect(isKnownAction('bogus:action')).toBe(false);
  });

  it('named constants resolve to the string values', () => {
    expect(ACTIONS.DashboardsRead).toBe('dashboards:read');
    expect(ACTIONS.AlertRulesCreate).toBe('alert.rules:create');
    expect(ACTIONS.ApprovalsOverride).toBe('approvals:override');
    expect(ACTIONS.OpsCommandsRun).toBe('ops.commands:run');
  });
});
