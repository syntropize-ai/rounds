/**
 * SA-with-Viewer-role flavor of the role gate. Confirms RBAC applies
 * uniformly whether the principal is a session-authed user or a Bearer-
 * authed service account.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { mintSaToken, deleteSa } from '../../helpers/sa.js';
import { apiAs, bearerAs } from '../../helpers/users.js';

describe('rbac/sa-roles/viewer-sa-cant-create-folder', () => {
  const cleanup: Array<() => Promise<void>> = [];

  afterAll(async () => {
    for (const fn of cleanup) {
      try { await fn(); } catch { /* noop */ }
    }
  }, 60_000);

  it('Viewer-role SA is forbidden from POST /api/folders', async () => {
    const sa = await mintSaToken({ role: 'Viewer' });
    cleanup.push(() => deleteSa(sa.saId));
    const result = await apiAs(bearerAs(sa.token), 'POST', '/api/folders', {
      title: `rbac-sa-viewer-${Date.now()}`,
    });
    expect(result.status).toBe(403);
  }, 60_000);
});
