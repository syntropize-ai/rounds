/**
 * Viewer lacks `plans:approve` and must get 403 from POST /api/plans/:id/approve.
 *
 * We hit a synthetic plan id; the auth gate fires before the not-found
 * check so a viewer sees 403 (not 404).
 */
import { afterAll, describe, expect, it } from 'vitest';
import { createUser, deleteUser, loginAs, apiAs } from '../../helpers/users.js';

describe('rbac/viewer-denied/plan-approve', () => {
  const cleanup: Array<() => Promise<void>> = [];

  afterAll(async () => {
    for (const fn of cleanup) {
      try { await fn(); } catch { /* noop */ }
    }
  }, 60_000);

  it('viewer is forbidden from POST /api/plans/:id/approve', async () => {
    const viewer = await createUser('Viewer');
    cleanup.push(() => deleteUser(viewer.id));
    const cookie = await loginAs(viewer);
    const result = await apiAs(cookie, 'POST', '/api/plans/does-not-exist/approve', {});
    expect(result.status).toBe(403);
  }, 60_000);
});
