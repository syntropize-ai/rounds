/**
 * Regression coverage — Task 16, scenario 1.
 *
 * Protects the AI-first dashboard build contract end-to-end across the
 * connectors_suggest → metrics_discover → metrics_validate →
 * dashboard_create → dashboard_add_panels handler chain. The individual
 * handlers each have unit tests; this scenario specifically protects the
 * cross-handler EVIDENCE chain (`ctx.dashboardBuildEvidence`) that gates
 * panel creation behind prior research + validation.
 *
 * If a future refactor breaks the evidence accumulation (e.g. forgets to
 * bump `metricDiscoveryCount` from metrics_discover, or stops gating
 * dashboard_add_panels on `validatedQueries.has(expr)`), this test fails.
 *
 * Related per-handler unit tests (do NOT duplicate):
 *   - dashboard_create / add_panels validation gates → dashboard.test.ts
 *   - metrics_discover per-kind shapes              → metrics.test.ts
 *   - metrics_validate ok / error                   → metrics.test.ts
 *   - connectors_suggest decision pyramid          -> connectors.test.ts
 */

import { describe, it, expect, vi } from 'vitest';
import {
  handleDashboardCreate,
  handleDashboardAddPanels,
} from '../dashboard.js';
import {
  handleMetricsDiscover,
  handleMetricsValidate,
} from '../metrics.js';
import { handleConnectorsSuggest } from '../connectors.js';
import { makeFakeActionContext } from '../_test-helpers.js';
import { AdapterRegistry } from '../../../adapters/registry.js';
import type { IMetricsAdapter } from '@agentic-obs/adapters';

function fakeMetricsAdapter(): IMetricsAdapter {
  return {
    instantQuery: vi.fn().mockResolvedValue([]),
    rangeQuery: vi.fn().mockResolvedValue([]),
    listLabels: vi.fn().mockResolvedValue(['job', 'instance']),
    listLabelValues: vi.fn().mockResolvedValue([]),
    findSeries: vi.fn().mockResolvedValue([]),
    fetchMetadata: vi.fn().mockResolvedValue({}),
    listMetricNames: vi
      .fn()
      .mockResolvedValue(['http_requests_total', 'http_request_duration_seconds']),
    testQuery: vi.fn().mockResolvedValue({ ok: true }),
    isHealthy: vi.fn(),
  } as unknown as IMetricsAdapter;
}

function buildCtxWithProm() {
  const adapters = new AdapterRegistry();
  adapters.register({
    info: {
      id: 'prom',
      name: 'prod-prom',
      type: 'prometheus',
      signalType: 'metrics',
      isDefault: true,
    },
    metrics: fakeMetricsAdapter(),
  });
  const create = vi.fn().mockResolvedValue({ id: 'dash-1', title: 'Latency' });
  const ctx = makeFakeActionContext({
    adapters,
    allConnectors: [
      {
        id: 'prom',
        name: 'prod-prom',
        type: 'prometheus',
        url: 'http://prom.local',
        isDefault: true,
      },
    ],
    store: {
      create,
      findById: vi.fn(),
      update: vi.fn(),
      updatePanels: vi.fn(),
      updateVariables: vi.fn(),
    } as never,
  });
  return ctx;
}

describe('regression: dashboard build flow (connectors -> discover -> validate -> create -> add_panels)', () => {
  it('full happy path: chain produces a created dashboard with one validated panel', async () => {
    const ctx = buildCtxWithProm();

    // 1) Pick the connector. With one default prometheus + matching
    //    intent, the suggest result is high-confidence and points at 'prom'.
    const suggest = await handleConnectorsSuggest(ctx, {
      userIntent: 'show me prod-prom request rate',
    });
    const suggestion = JSON.parse(suggest) as { recommendedId: string | null };
    expect(suggestion.recommendedId).toBe('prom');

    // 2) Discover metric names — bumps metricDiscoveryCount so subsequent
    //    queried-panel additions can pass the "no research" gate.
    const discover = await handleMetricsDiscover(ctx, {
      sourceId: 'prom',
      kind: 'names',
      match: 'http_request',
    });
    expect(discover).toContain('http_requests_total');
    expect(ctx.dashboardBuildEvidence.metricDiscoveryCount).toBeGreaterThan(0);

    // 3) Validate the candidate expression — must record into validatedQueries.
    const expr = 'sum(rate(http_requests_total[5m]))';
    const validate = await handleMetricsValidate(ctx, {
      sourceId: 'prom',
      query: expr,
    });
    expect(validate).toMatch(/Valid query/);
    expect(ctx.dashboardBuildEvidence.validatedQueries.has(expr)).toBe(true);

    // 4) Create dashboard — sets activeDashboardId and marks it freshly created.
    const create = await handleDashboardCreate(ctx, {
      title: 'Latency',
      datasourceId: 'prom',
    });
    expect(create).toContain('Created dashboard "Latency"');
    expect(ctx.activeDashboardId).toBe('dash-1');
    expect(ctx.freshlyCreatedDashboards.has('dash-1')).toBe(true);

    // 5) Add panels with the validated expression — passes both the
    //    research gate (metricDiscoveryCount > 0) AND the validation gate
    //    (validatedQueries has expr). Both gates are required.
    const addPanels = await handleDashboardAddPanels(ctx, {
      panels: [
        {
          title: 'Request rate',
          visualization: 'time_series',
          queries: [{ refId: 'A', expr, datasourceId: 'prom' }],
        },
      ],
    });
    expect(addPanels).toContain('Added 1 panel(s): Request rate');
    expect(ctx.actionExecutor.execute).toHaveBeenCalledWith(
      'dash-1',
      [expect.objectContaining({ type: 'add_panels' })],
    );
  });

  it('add_panels for a queried panel fails when the chain skips metrics_validate', async () => {
    // Same flow, but skip step 3. The discovery evidence is enough to pass
    // the research gate, but the per-expression validation gate must still
    // reject. This protects against silent regression of the validate gate.
    const ctx = buildCtxWithProm();
    await handleConnectorsSuggest(ctx, { userIntent: 'prod-prom' });
    await handleMetricsDiscover(ctx, { sourceId: 'prom', kind: 'names' });
    await handleDashboardCreate(ctx, { title: 'Latency', datasourceId: 'prom' });

    const observation = await handleDashboardAddPanels(ctx, {
      panels: [
        {
          title: 'Unvalidated panel',
          visualization: 'time_series',
          queries: [
            {
              refId: 'A',
              expr: 'sum(rate(http_requests_total[5m]))',
              datasourceId: 'prom',
            },
          ],
        },
      ],
    });
    expect(observation).toMatch(/validate panel queries/);
    expect(ctx.actionExecutor.execute).not.toHaveBeenCalled();
  });

  it('add_panels for a queried panel fails when no metrics_discover ran', async () => {
    // Skip step 2 (discover). Even if we somehow validated a query, the
    // research gate must still reject the panel because there's no evidence
    // the model surveyed available metrics first.
    const ctx = buildCtxWithProm();
    await handleConnectorsSuggest(ctx, { userIntent: 'prod-prom' });
    await handleDashboardCreate(ctx, { title: 'Latency', datasourceId: 'prom' });
    // Force a validated query into evidence WITHOUT a discover call.
    ctx.dashboardBuildEvidence.validatedQueries.add('up');

    const observation = await handleDashboardAddPanels(ctx, {
      panels: [
        {
          title: 'No-research panel',
          visualization: 'time_series',
          queries: [{ refId: 'A', expr: 'up', datasourceId: 'prom' }],
        },
      ],
    });
    expect(observation).toMatch(/requires prior metric research/);
    expect(ctx.actionExecutor.execute).not.toHaveBeenCalled();
  });
});
