/**
 * Service-account list (`GET /api/serviceaccounts`) requires
 * `serviceaccounts:read` — Admin grants it, Editor doesn't.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { createUser, deleteUser, loginAs, apiAs } from '../../helpers/users.js';

describe('rbac/admin-only/serviceaccounts-list', () => {
  const cleanup: Array<() => Promise<void>> = [];

  afterAll(async () => {
    for (const fn of cleanup) {
      try { await fn(); } catch { /* noop */ }
    }
  }, 60_000);

  it('editor GET /api/serviceaccounts/search returns 403', async () => {
    const editor = await createUser('Editor');
    cleanup.push(() => deleteUser(editor.id));
    const cookie = await loginAs(editor);
    const result = await apiAs(cookie, 'GET', '/api/serviceaccounts/search');
    expect(result.status).toBe(403);
  }, 60_000);

  it('admin GET /api/serviceaccounts/search does not return 403', async () => {
    const admin = await createUser('Admin');
    cleanup.push(() => deleteUser(admin.id));
    const cookie = await loginAs(admin);
    const result = await apiAs(cookie, 'GET', '/api/serviceaccounts/search');
    expect(result.status).not.toBe(403);
    expect([200, 404]).toContain(result.status);
  }, 60_000);
});
