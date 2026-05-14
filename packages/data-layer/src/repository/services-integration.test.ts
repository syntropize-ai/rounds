/**
 * Integration: end-to-end Tier-1 attribution flow at the repository layer.
 *
 * Scenario from the W2/T2 spec: create 3 dashboards, two with a
 * `service="foo"` PromQL label and one without → `listServices` returns
 * foo with resourceCount=2 and `listUnassigned` flags the third.
 *
 * The route test would re-exercise the same code path through one extra
 * hop; vite's deep-import resolution makes cross-package wiring noisy in
 * vitest, so the integration assertion lives at the repository edge.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { InMemoryServiceAttributionRepository } from './memory/service-attribution.js';
import { applyTier1PromqlAttribution } from './service-attribution-tier1.js';

describe('service attribution integration (Tier-1 PromQL)', () => {
  let attribution: InMemoryServiceAttributionRepository;

  beforeEach(() => {
    attribution = new InMemoryServiceAttributionRepository();
  });

  it('3 dashboards: 2 with service=foo + 1 without → listServices=foo (count 2), 1 unassigned', async () => {
    const orgId = 'org_main';
    const dashboardIds = ['d1', 'd2', 'd3'];

    // d1 and d2 carry a `service="foo"` label, d3 does not.
    const cases: Array<{ id: string; queries: string[] }> = [
      { id: 'd1', queries: ['rate(http_requests_total{service="foo"}[5m])'] },
      { id: 'd2', queries: ['rate(errors_total{service="foo",job="api"}[5m])'] },
      { id: 'd3', queries: ['rate(http_requests_total{job="api"}[5m])'] },
    ];
    for (const c of cases) {
      await applyTier1PromqlAttribution(attribution, orgId, {
        kind: 'dashboard',
        id: c.id,
        queries: c.queries,
      });
    }

    const services = await attribution.listServices(orgId);
    expect(services).toEqual([{ name: 'foo', resourceCount: 2 }]);

    const unassigned = await attribution.listUnassigned(orgId, 'dashboard', dashboardIds);
    expect(unassigned).toEqual(['d3']);
  });

  it('manual confirm writes user_confirmed row that overrides absence of label', async () => {
    const orgId = 'org_main';
    // d1 has no service label → unassigned at first.
    await applyTier1PromqlAttribution(attribution, orgId, {
      kind: 'dashboard',
      id: 'd1',
      queries: ['rate(http_requests_total[5m])'],
    });
    expect(await attribution.listUnassigned(orgId, 'dashboard', ['d1'])).toEqual(['d1']);

    // User assigns to checkout-api → now visible.
    await attribution.confirmAttribution(orgId, 'dashboard', 'd1', 'checkout-api', 'u1');
    expect(await attribution.listUnassigned(orgId, 'dashboard', ['d1'])).toEqual([]);
    const services = await attribution.listServices(orgId);
    expect(services).toEqual([{ name: 'checkout-api', resourceCount: 1 }]);
  });
});
