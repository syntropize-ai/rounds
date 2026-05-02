/**
 * Datasource creation (`POST /api/datasources`) requires `datasources:create`.
 * Admin grants it; Editor only gets `datasources:query`/`read`.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { createUser, deleteUser, loginAs, apiAs } from '../../helpers/users.js';
import { apiDelete } from '../../helpers/api-client.js';

describe('rbac/admin-only/datasource-create', () => {
  const cleanup: Array<() => Promise<void>> = [];

  afterAll(async () => {
    for (const fn of cleanup) {
      try { await fn(); } catch { /* noop */ }
    }
  }, 60_000);

  it('editor POST /api/datasources returns 403', async () => {
    const editor = await createUser('Editor');
    cleanup.push(() => deleteUser(editor.id));
    const cookie = await loginAs(editor);
    const result = await apiAs(cookie, 'POST', '/api/datasources', {
      name: `rbac-editor-ds-${Date.now()}`,
      type: 'prometheus',
      url: 'http://example.invalid',
    });
    expect(result.status).toBe(403);
  }, 60_000);

  it('admin POST /api/datasources does not return 403', async () => {
    const admin = await createUser('Admin');
    cleanup.push(() => deleteUser(admin.id));
    const cookie = await loginAs(admin);
    const result = await apiAs(cookie, 'POST', '/api/datasources', {
      name: `rbac-admin-ds-${Date.now()}`,
      type: 'prometheus',
      url: 'http://example.invalid',
    });
    expect(result.status).not.toBe(403);
    const ds = result.body as { id?: string; uid?: string };
    if (ds?.uid) cleanup.push(() => apiDelete(`/api/datasources/${ds.uid}`));
    else if (ds?.id) cleanup.push(() => apiDelete(`/api/datasources/${ds.id}`));
  }, 60_000);
});
