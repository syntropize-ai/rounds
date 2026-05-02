/**
 * Editor-role SA can create folders (mirror of the user-flavored
 * editor-allowed/folder-create scenario).
 */
import { afterAll, describe, expect, it } from 'vitest';
import { mintSaToken, deleteSa } from '../../helpers/sa.js';
import { apiAs, bearerAs } from '../../helpers/users.js';
import { deleteFolder } from '../../helpers/folders.js';

describe('rbac/sa-roles/editor-sa-can-create-folder', () => {
  const cleanup: Array<() => Promise<void>> = [];

  afterAll(async () => {
    for (const fn of cleanup) {
      try { await fn(); } catch { /* noop */ }
    }
  }, 60_000);

  it('Editor-role SA POST /api/folders does not return 403', async () => {
    const sa = await mintSaToken({ role: 'Editor' });
    cleanup.push(() => deleteSa(sa.saId));
    const result = await apiAs(bearerAs(sa.token), 'POST', '/api/folders', {
      title: `rbac-sa-editor-${Date.now()}`,
    });
    expect(result.status).not.toBe(403);
    expect([200, 201]).toContain(result.status);
    const folder = result.body as { uid?: string };
    if (folder?.uid) cleanup.push(() => deleteFolder(folder.uid!));
  }, 60_000);
});
