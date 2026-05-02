/**
 * /api/admin/users is gated on the server-admin flag (`req.auth.isServerAdmin`)
 * — not just any Admin org-role. This is the canonical "Pattern C" admin-only
 * test from the RBAC matrix.
 *
 * Editor (org-only) → 403
 * Admin  (org-only) → 403 (NOT a server admin)
 * Server Admin       → 200
 */
import { afterAll, describe, expect, it } from 'vitest';
import {
  createUser,
  createServerAdmin,
  deleteUser,
  loginAs,
  apiAs,
} from '../../helpers/users.js';

describe('rbac/server-admin-only/admin-users-list', () => {
  const cleanup: Array<() => Promise<void>> = [];

  afterAll(async () => {
    for (const fn of cleanup) {
      try { await fn(); } catch { /* noop */ }
    }
  }, 60_000);

  it('editor GET /api/admin/users returns 403', async () => {
    const editor = await createUser('Editor');
    cleanup.push(() => deleteUser(editor.id));
    const cookie = await loginAs(editor);
    const result = await apiAs(cookie, 'GET', '/api/admin/users');
    expect(result.status).toBe(403);
  }, 60_000);

  it('org-admin (non-server) GET /api/admin/users returns 403', async () => {
    const admin = await createUser('Admin');
    cleanup.push(() => deleteUser(admin.id));
    const cookie = await loginAs(admin);
    const result = await apiAs(cookie, 'GET', '/api/admin/users');
    expect(result.status).toBe(403);
  }, 60_000);

  it('server-admin GET /api/admin/users returns 200', async () => {
    const sa = await createServerAdmin();
    cleanup.push(() => deleteUser(sa.id));
    const cookie = await loginAs(sa);
    const result = await apiAs(cookie, 'GET', '/api/admin/users');
    expect(result.status).toBe(200);
  }, 60_000);
});
