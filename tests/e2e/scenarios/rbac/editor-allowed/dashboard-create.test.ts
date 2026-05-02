/**
 * Editor has `dashboards:create` and must NOT get 403 from POST /api/dashboards.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { createUser, deleteUser, loginAs, apiAs } from '../../helpers/users.js';
import { apiDelete } from '../../helpers/api-client.js';

describe('rbac/editor-allowed/dashboard-create', () => {
  const cleanup: Array<() => Promise<void>> = [];

  afterAll(async () => {
    for (const fn of cleanup) {
      try { await fn(); } catch { /* noop */ }
    }
  }, 60_000);

  it('editor can POST /api/dashboards (auth gate passes)', async () => {
    const editor = await createUser('Editor');
    cleanup.push(() => deleteUser(editor.id));
    const cookie = await loginAs(editor);
    const result = await apiAs(cookie, 'POST', '/api/dashboards', {
      prompt: 'rbac editor dashboard create test',
      title: `rbac-editor-${Date.now()}`,
    });
    // Permission gate must pass; 200/201 on success, 4xx/5xx for downstream
    // (LLM/etc.) errors are still acceptable — we only assert non-403.
    expect(result.status).not.toBe(403);
    const created = result.body as { id?: string };
    if (created?.id) cleanup.push(() => apiDelete(`/api/dashboards/${created.id}`));
  }, 60_000);
});
