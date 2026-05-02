/**
 * Viewer lacks `alert.silences:create` and must get 403 from
 * POST /api/alert-rules/silences.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { createUser, deleteUser, loginAs, apiAs } from '../../helpers/users.js';

describe('rbac/viewer-denied/silence-create', () => {
  const cleanup: Array<() => Promise<void>> = [];

  afterAll(async () => {
    for (const fn of cleanup) {
      try { await fn(); } catch { /* noop */ }
    }
  }, 60_000);

  it('viewer is forbidden from POST /api/alert-rules/silences', async () => {
    const viewer = await createUser('Viewer');
    cleanup.push(() => deleteUser(viewer.id));
    const cookie = await loginAs(viewer);
    const now = new Date();
    const later = new Date(now.getTime() + 60_000);
    const result = await apiAs(cookie, 'POST', '/api/alert-rules/silences', {
      matchers: [{ name: 'alertname', value: 'rbac-test', isRegex: false }],
      startsAt: now.toISOString(),
      endsAt: later.toISOString(),
      comment: 'rbac viewer test',
    });
    expect(result.status).toBe(403);
  }, 60_000);
});
