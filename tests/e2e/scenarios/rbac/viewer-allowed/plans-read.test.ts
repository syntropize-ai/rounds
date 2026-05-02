/**
 * Viewer has `plans:read` so GET /api/plans must not 403.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { createUser, deleteUser, loginAs, apiAs } from '../../helpers/users.js';

describe('rbac/viewer-allowed/plans-read', () => {
  const cleanup: Array<() => Promise<void>> = [];

  afterAll(async () => {
    for (const fn of cleanup) {
      try { await fn(); } catch { /* noop */ }
    }
  }, 60_000);

  it('viewer GET /api/plans returns 200 (not 403)', async () => {
    const viewer = await createUser('Viewer');
    cleanup.push(() => deleteUser(viewer.id));
    const cookie = await loginAs(viewer);
    const result = await apiAs(cookie, 'GET', '/api/plans');
    expect(result.status).not.toBe(403);
    expect(result.status).toBe(200);
  }, 60_000);
});
