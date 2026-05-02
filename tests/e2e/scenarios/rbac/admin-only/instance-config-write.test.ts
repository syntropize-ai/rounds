/**
 * Instance-config writes (`POST /api/setup/reset`, `POST /api/setup/llm/test`)
 * require `instance.config:write` — Admin grants it, Editor doesn't.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { createUser, deleteUser, loginAs, apiAs } from '../../helpers/users.js';

describe('rbac/admin-only/instance-config-write', () => {
  const cleanup: Array<() => Promise<void>> = [];

  afterAll(async () => {
    for (const fn of cleanup) {
      try { await fn(); } catch { /* noop */ }
    }
  }, 60_000);

  it('editor POST /api/setup/llm/test returns 403', async () => {
    const editor = await createUser('Editor');
    cleanup.push(() => deleteUser(editor.id));
    const cookie = await loginAs(editor);
    const result = await apiAs(cookie, 'POST', '/api/setup/llm/test', {
      provider: 'openai',
      model: 'gpt-4',
    });
    expect(result.status).toBe(403);
  }, 60_000);

  it('admin POST /api/setup/llm/test does not return 403', async () => {
    const admin = await createUser('Admin');
    cleanup.push(() => deleteUser(admin.id));
    const cookie = await loginAs(admin);
    const result = await apiAs(cookie, 'POST', '/api/setup/llm/test', {
      provider: 'openai',
      model: 'gpt-4',
    });
    // Provider call may fail (400/502); RBAC check is just non-403.
    expect(result.status).not.toBe(403);
  }, 60_000);
});
