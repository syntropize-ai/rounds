/**
 * Team creation (`POST /api/teams`) requires `teams:create` — Admin grants
 * it, Editor doesn't.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { createUser, deleteUser, loginAs, apiAs } from '../../helpers/users.js';
import { apiDelete } from '../../helpers/api-client.js';

describe('rbac/admin-only/teams-create', () => {
  const cleanup: Array<() => Promise<void>> = [];

  afterAll(async () => {
    for (const fn of cleanup) {
      try { await fn(); } catch { /* noop */ }
    }
  }, 60_000);

  it('editor POST /api/teams returns 403', async () => {
    const editor = await createUser('Editor');
    cleanup.push(() => deleteUser(editor.id));
    const cookie = await loginAs(editor);
    const result = await apiAs(cookie, 'POST', '/api/teams', {
      name: `rbac-editor-team-${Date.now()}`,
    });
    expect(result.status).toBe(403);
  }, 60_000);

  it('admin POST /api/teams does not return 403', async () => {
    const admin = await createUser('Admin');
    cleanup.push(() => deleteUser(admin.id));
    const cookie = await loginAs(admin);
    const result = await apiAs(cookie, 'POST', '/api/teams', {
      name: `rbac-admin-team-${Date.now()}`,
    });
    expect(result.status).not.toBe(403);
    const team = result.body as { id?: string | number };
    if (team?.id !== undefined) cleanup.push(() => apiDelete(`/api/teams/${team.id}`));
  }, 60_000);
});
