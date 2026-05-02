/**
 * Editor has `folders:create` and must NOT get 403 from POST /api/folders.
 * Cleans up the created folder via the SA admin token.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { createUser, deleteUser, loginAs, apiAs } from '../../helpers/users.js';
import { deleteFolder } from '../../helpers/folders.js';

describe('rbac/editor-allowed/folder-create', () => {
  const cleanup: Array<() => Promise<void>> = [];

  afterAll(async () => {
    for (const fn of cleanup) {
      try { await fn(); } catch { /* noop */ }
    }
  }, 60_000);

  it('editor can POST /api/folders', async () => {
    const editor = await createUser('Editor');
    cleanup.push(() => deleteUser(editor.id));
    const cookie = await loginAs(editor);
    const title = `rbac-editor-${Date.now()}`;
    const result = await apiAs(cookie, 'POST', '/api/folders', { title });
    expect(result.status).not.toBe(403);
    expect([200, 201]).toContain(result.status);
    const folder = result.body as { uid?: string };
    if (folder?.uid) cleanup.push(() => deleteFolder(folder.uid!));
  }, 60_000);
});
