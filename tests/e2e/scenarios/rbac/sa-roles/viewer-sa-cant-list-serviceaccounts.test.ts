/**
 * SA-with-Viewer-role can't list service accounts.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { mintSaToken, deleteSa } from '../../helpers/sa.js';
import { apiAs, bearerAs } from '../../helpers/users.js';

describe('rbac/sa-roles/viewer-sa-cant-list-serviceaccounts', () => {
  const cleanup: Array<() => Promise<void>> = [];

  afterAll(async () => {
    for (const fn of cleanup) {
      try { await fn(); } catch { /* noop */ }
    }
  }, 60_000);

  it('Viewer-role SA GET /api/serviceaccounts/search returns 403', async () => {
    const sa = await mintSaToken({ role: 'Viewer' });
    cleanup.push(() => deleteSa(sa.saId));
    const result = await apiAs(bearerAs(sa.token), 'GET', '/api/serviceaccounts/search');
    expect(result.status).toBe(403);
  }, 60_000);
});
