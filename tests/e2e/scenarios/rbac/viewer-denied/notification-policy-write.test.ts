/**
 * Viewer lacks `alert.notifications:write` and must get 403 from
 * POST /api/alert-rules/notifications/* (notification-channel mutation).
 *
 * The notification-write surface lives at PUT /api/alert-rules/notifications;
 * we use POST on the channel collection if available — the actual route used
 * is PUT against /alert-notifications/test as the canonical write probe.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { createUser, deleteUser, loginAs, apiAs } from '../../helpers/users.js';

describe('rbac/viewer-denied/notification-policy-write', () => {
  const cleanup: Array<() => Promise<void>> = [];

  afterAll(async () => {
    for (const fn of cleanup) {
      try { await fn(); } catch { /* noop */ }
    }
  }, 60_000);

  it('viewer is forbidden from notification-channel mutation', async () => {
    const viewer = await createUser('Viewer');
    cleanup.push(() => deleteUser(viewer.id));
    const cookie = await loginAs(viewer);
    // POST /api/alert-rules/notifications hits AlertNotificationsWrite.
    const result = await apiAs(cookie, 'POST', '/api/alert-rules/notifications', {
      name: 'rbac-viewer-channel',
      type: 'webhook',
      settings: { url: 'http://example.invalid' },
    });
    expect(result.status).toBe(403);
  }, 60_000);
});
