/**
 * /api/admin/audit-log is server-admin-only.
 */
import { afterAll, describe, expect, it } from 'vitest';
import {
  createUser,
  createServerAdmin,
  deleteUser,
  loginAs,
  apiAs,
} from '../../helpers/users.js';

describe('rbac/server-admin-only/admin-audit-log', () => {
  const cleanup: Array<() => Promise<void>> = [];

  afterAll(async () => {
    for (const fn of cleanup) {
      try { await fn(); } catch { /* noop */ }
    }
  }, 60_000);

  it('org-admin GET /api/admin/audit-log returns 403', async () => {
    const admin = await createUser('Admin');
    cleanup.push(() => deleteUser(admin.id));
    const cookie = await loginAs(admin);
    const result = await apiAs(cookie, 'GET', '/api/admin/audit-log');
    expect(result.status).toBe(403);
  }, 60_000);

  it('server-admin GET /api/admin/audit-log returns 200', async () => {
    const sa = await createServerAdmin();
    cleanup.push(() => deleteUser(sa.id));
    const cookie = await loginAs(sa);
    const result = await apiAs(cookie, 'GET', '/api/admin/audit-log');
    expect(result.status).toBe(200);
  }, 60_000);
});
