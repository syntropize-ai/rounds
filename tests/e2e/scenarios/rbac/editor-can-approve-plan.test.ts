/**
 * Editor role carries `approvals:approve` (and `plans:approve`) so
 * POST /api/plans/:id/approve must NOT 403 for an Editor.
 *
 * We don't drive a full plan to completion here (the LLM-driven plan
 * scenarios cover that). We just confirm the auth gate doesn't block
 * the editor: if no plan is available we synthesize the call and assert
 * the response is anything OTHER than 403.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { createUser, deleteUser, loginAs, apiAs } from '../helpers/users.js';

describe('rbac/editor-can-approve-plan', () => {
  const cleanup: Array<() => Promise<void>> = [];

  afterAll(async () => {
    for (const fn of cleanup) {
      try { await fn(); } catch { /* noop */ }
    }
  }, 60_000);

  it('editor approval call does not return 403', async () => {
    const editor = await createUser('Editor');
    cleanup.push(() => deleteUser(editor.id));
    const cookie = await loginAs(editor);
    // Hit a synthetic plan id; we expect 404 (or similar), not 403.
    const result = await apiAs(cookie, 'POST', '/api/plans/does-not-exist/approve', {});
    expect(result.status).not.toBe(403);
    // Also assert it's a sensible non-success — we don't expect 200 either.
    expect([404, 400, 500]).toContain(result.status);
  }, 60_000);
});
