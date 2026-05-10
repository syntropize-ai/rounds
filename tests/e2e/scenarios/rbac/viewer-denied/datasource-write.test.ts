/**
 * Viewer lacks `connectors:create` and must get 403 from POST /api/connectors.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { createUser, deleteUser, loginAs, apiAs } from '../../helpers/users.js';

describe('rbac/viewer-denied/connector-write', () => {
  const cleanup: Array<() => Promise<void>> = [];

  afterAll(async () => {
    for (const fn of cleanup) {
      try { await fn(); } catch { /* noop */ }
    }
  }, 60_000);

  it('viewer is forbidden from POST /api/connectors', async () => {
    const viewer = await createUser('Viewer');
    cleanup.push(() => deleteUser(viewer.id));
    const cookie = await loginAs(viewer);
    const result = await apiAs(cookie, 'POST', '/api/connectors', {
      name: `rbac-viewer-ds-${Date.now()}`,
      type: 'prometheus',
      config: { url: 'http://example.invalid' },
    });
    expect(result.status).toBe(403);
  }, 60_000);
});
