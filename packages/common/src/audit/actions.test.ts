import { describe, it, expect } from 'vitest';
import { AuditAction, AUDIT_ACTIONS, isAuditAction } from './actions.js';

describe('AuditAction catalog', () => {
  it('contains every documented category', () => {
    // Spot check representative members from each group per §02.
    expect(AuditAction.UserLogin).toBe('user.login');
    expect(AuditAction.UserLoginFailed).toBe('user.login_failed');
    expect(AuditAction.UserLogout).toBe('user.logout');
    expect(AuditAction.UserRoleChanged).toBe('user.role_changed');
    expect(AuditAction.SessionRevoked).toBe('session.revoked');
    expect(AuditAction.OrgUserAdded).toBe('org.user_added');
    expect(AuditAction.TeamMemberAdded).toBe('team.member_added');
    expect(AuditAction.RoleCreated).toBe('role.created');
    expect(AuditAction.ServiceAccountTokenCreated).toBe(
      'serviceaccount.token_created',
    );
    expect(AuditAction.ApiKeyCreated).toBe('apikey.created');
    expect(AuditAction.PermissionGranted).toBe('permission.granted');
  });

  it('includes fork actions for dashboard + alert_rule (Wave 2 / Step 5)', () => {
    expect(AuditAction.DashboardFork).toBe('dashboard.fork');
    expect(AuditAction.AlertRuleFork).toBe('alert_rule.fork');
  });

  it('has no duplicate values', () => {
    const values = Object.values(AuditAction);
    const set = new Set(values);
    expect(set.size).toBe(values.length);
  });

  it('isAuditAction narrows correctly', () => {
    expect(isAuditAction('user.login')).toBe(true);
    expect(isAuditAction('made.up.action')).toBe(false);
  });

  it('AUDIT_ACTIONS length matches enum value count', () => {
    expect(AUDIT_ACTIONS.length).toBe(Object.keys(AuditAction).length);
  });

  it('every action follows dotted namespace:verb convention', () => {
    for (const v of AUDIT_ACTIONS) {
      expect(v).toMatch(/^[a-z_]+\.[a-z_]+$/);
    }
  });
});
