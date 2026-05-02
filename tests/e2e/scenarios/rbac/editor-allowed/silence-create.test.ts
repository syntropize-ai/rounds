/**
 * Editor has `alert.silences:create` so POST /api/alert-rules/silences
 * must not 403 for an editor. We assert on the auth gate, not the
 * downstream business outcome.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { createUser, deleteUser, loginAs, apiAs } from '../../helpers/users.js';

describe('rbac/editor-allowed/silence-create', () => {
  const cleanup: Array<() => Promise<void>> = [];

  afterAll(async () => {
    for (const fn of cleanup) {
      try { await fn(); } catch { /* noop */ }
    }
  }, 60_000);

  it('editor POST /api/alert-rules/silences does not return 403', async () => {
    const editor = await createUser('Editor');
    cleanup.push(() => deleteUser(editor.id));
    const cookie = await loginAs(editor);
    const now = new Date();
    const later = new Date(now.getTime() + 60_000);
    const result = await apiAs(cookie, 'POST', '/api/alert-rules/silences', {
      matchers: [{ name: 'alertname', value: 'rbac-editor-test', isRegex: false }],
      startsAt: now.toISOString(),
      endsAt: later.toISOString(),
      comment: 'rbac editor test',
    });
    expect(result.status).not.toBe(403);
  }, 60_000);
});
