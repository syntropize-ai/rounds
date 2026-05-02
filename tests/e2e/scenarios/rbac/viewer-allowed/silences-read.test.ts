/**
 * Viewer has `alert.silences:read` so GET /api/alert-rules/silences must not 403.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { createUser, deleteUser, loginAs, apiAs } from '../../helpers/users.js';

describe('rbac/viewer-allowed/silences-read', () => {
  const cleanup: Array<() => Promise<void>> = [];

  afterAll(async () => {
    for (const fn of cleanup) {
      try { await fn(); } catch { /* noop */ }
    }
  }, 60_000);

  it('viewer GET /api/alert-rules/silences returns 200', async () => {
    const viewer = await createUser('Viewer');
    cleanup.push(() => deleteUser(viewer.id));
    const cookie = await loginAs(viewer);
    const result = await apiAs(cookie, 'GET', '/api/alert-rules/silences');
    expect(result.status).toBe(200);
  }, 60_000);
});
