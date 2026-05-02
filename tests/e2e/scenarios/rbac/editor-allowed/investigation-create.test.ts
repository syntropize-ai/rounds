/**
 * Editor has `investigations:create` so POST /api/investigations must
 * not 403 for an editor.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { createUser, deleteUser, loginAs, apiAs } from '../../helpers/users.js';
import { apiDelete } from '../../helpers/api-client.js';

describe('rbac/editor-allowed/investigation-create', () => {
  const cleanup: Array<() => Promise<void>> = [];

  afterAll(async () => {
    for (const fn of cleanup) {
      try { await fn(); } catch { /* noop */ }
    }
  }, 60_000);

  it('editor POST /api/investigations does not return 403', async () => {
    const editor = await createUser('Editor');
    cleanup.push(() => deleteUser(editor.id));
    const cookie = await loginAs(editor);
    const result = await apiAs(cookie, 'POST', '/api/investigations', {
      summary: 'rbac editor create test',
    });
    expect(result.status).not.toBe(403);
    const inv = result.body as { id?: string };
    if (inv?.id) cleanup.push(() => apiDelete(`/api/investigations/${inv.id}`));
  }, 60_000);
});
