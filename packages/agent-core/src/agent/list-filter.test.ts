/**
 * filterByPermission behavior, exercised via the AccessControlStub helper.
 *
 * The stub mirrors the api-gateway `AccessControlService.filterByPermission`
 * contract: drop items where the evaluator doesn't pass. The real service is
 * unit-tested in api-gateway; this file guards the agent-core consumer side.
 */

import { describe, it, expect } from 'vitest';
import { ac } from '@agentic-obs/common';
import { AccessControlStub, makeTestIdentity } from './test-helpers.js';

describe('filterByPermission (AccessControlStub)', () => {
  it('keeps items whose evaluator passes', async () => {
    const stub = new AccessControlStub((_id, e) =>
      e.string().endsWith('dashboards:uid:allowed'),
    );
    const items = [{ id: 'allowed' }, { id: 'denied' }];
    const kept = await stub.filterByPermission(
      makeTestIdentity(),
      items,
      (d) => ac.eval('dashboards:read', `dashboards:uid:${d.id}`),
    );
    expect(kept.map((x) => x.id)).toEqual(['allowed']);
  });

  it('returns empty when nothing is allowed', async () => {
    const stub = new AccessControlStub(() => false);
    const kept = await stub.filterByPermission(
      makeTestIdentity(),
      [{ id: 'a' }, { id: 'b' }],
      (d) => ac.eval('dashboards:read', `dashboards:uid:${d.id}`),
    );
    expect(kept).toEqual([]);
  });

  it('returns all when the predicate says yes (Admin default)', async () => {
    const stub = new AccessControlStub();
    const kept = await stub.filterByPermission(
      makeTestIdentity({ orgRole: 'Admin' }),
      [{ id: 'a' }, { id: 'b' }, { id: 'c' }],
      (d) => ac.eval('dashboards:read', `dashboards:uid:${d.id}`),
    );
    expect(kept.map((x) => x.id)).toEqual(['a', 'b', 'c']);
  });
});
