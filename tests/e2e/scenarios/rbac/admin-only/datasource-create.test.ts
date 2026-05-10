/**
 * Connector creation (`POST /api/connectors`) requires `connectors:create`.
 * Admin grants it; Editor only gets `connectors:query`/`read`.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { createUser, deleteUser, loginAs, apiAs } from '../../helpers/users.js';
import { apiDelete } from '../../helpers/api-client.js';

describe('rbac/admin-only/connector-create', () => {
  const cleanup: Array<() => Promise<void>> = [];

  afterAll(async () => {
    for (const fn of cleanup) {
      try { await fn(); } catch { /* noop */ }
    }
  }, 60_000);

  it('editor POST /api/connectors returns 403', async () => {
    const editor = await createUser('Editor');
    cleanup.push(() => deleteUser(editor.id));
    const cookie = await loginAs(editor);
    const result = await apiAs(cookie, 'POST', '/api/connectors', {
      name: `rbac-editor-ds-${Date.now()}`,
      type: 'prometheus',
      config: { url: 'http://example.invalid' },
    });
    expect(result.status).toBe(403);
  }, 60_000);

  it('admin POST /api/connectors does not return 403', async () => {
    const admin = await createUser('Admin');
    cleanup.push(() => deleteUser(admin.id));
    const cookie = await loginAs(admin);
    const result = await apiAs(cookie, 'POST', '/api/connectors', {
      name: `rbac-admin-ds-${Date.now()}`,
      type: 'prometheus',
      config: { url: 'http://example.invalid' },
    });
    expect(result.status).not.toBe(403);
    const body = result.body as { connector?: { id?: string }; id?: string };
    const id = body.connector?.id ?? body.id;
    if (id) cleanup.push(() => apiDelete(`/api/connectors/${id}`));
  }, 60_000);
});
