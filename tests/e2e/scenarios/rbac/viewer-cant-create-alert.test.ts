/**
 * A Viewer-role user lacks `alert.rules:create` and must get 403 from
 * POST /api/alert-rules/generate.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { createUser, deleteUser, loginAs, apiAs } from '../helpers/users.js';

describe('rbac/viewer-cant-create-alert', () => {
  const cleanup: Array<() => Promise<void>> = [];

  afterAll(async () => {
    for (const fn of cleanup) {
      try { await fn(); } catch { /* noop */ }
    }
  }, 60_000);

  it('viewer is forbidden from POST /api/alert-rules/generate', async () => {
    const viewer = await createUser('Viewer');
    cleanup.push(() => deleteUser(viewer.id));
    const cookie = await loginAs(viewer);
    const result = await apiAs(cookie, 'POST', '/api/alert-rules/generate', {
      prompt: 'create alert viewer-test: PromQL up < 1 for 30s severity low',
    });
    expect(result.status).toBe(403);
  }, 60_000);
});
