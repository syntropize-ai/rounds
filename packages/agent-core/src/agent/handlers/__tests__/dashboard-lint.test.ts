/**
 * Tests for the dashboard_lint handler:
 *   - the basic happy path returns a "0 errors" summary
 *   - error-severity issues surface in the observation
 *   - rules that need a metrics adapter degrade to info when none is wired
 *   - the spec shape is validated up front
 */
import { describe, it, expect, vi } from 'vitest';
import { handleDashboardLint } from '../dashboard-lint.js';
import { makeFakeActionContext } from '../_test-helpers.js';
import { AdapterRegistry } from '../../../adapters/registry.js';

function mkSpec(overrides: Record<string, unknown> = {}) {
  return {
    id: 'd1',
    type: 'dashboard',
    title: 't',
    description: '',
    prompt: '',
    userId: 'u',
    status: 'ready',
    panels: [
      {
        id: 'p1',
        title: 'Request rate',
        description: 'Q: how busy?',
        visualization: 'time_series',
        row: 0, col: 0, width: 12, height: 8,
        query: 'sum(rate(http_requests_total[5m]))',
      },
    ],
    variables: [],
    refreshIntervalSec: 30,
    datasourceIds: [],
    useExistingMetrics: true,
    createdAt: 'x',
    updatedAt: 'x',
    ...overrides,
  };
}

describe('handleDashboardLint', () => {
  it('returns a clean summary when there are no issues and no adapter wired', async () => {
    const ctx = makeFakeActionContext({});
    const out = await handleDashboardLint(ctx, { spec: mkSpec() });
    // Without a metrics adapter, query/label/cardinality rules emit info
    // "rule skipped" issues. Errors should be 0.
    expect(out).toMatch(/Lint complete: 0 errors/);
  });

  it('surfaces the dashboard-has-questions error when a panel lacks Q:', async () => {
    const ctx = makeFakeActionContext({});
    const bad = mkSpec({
      panels: [{
        id: 'p1', title: 'X', description: 'nope',
        visualization: 'time_series', row: 0, col: 0, width: 12, height: 8,
        query: 'up',
      }],
    });
    const out = await handleDashboardLint(ctx, { spec: bad });
    expect(out).toMatch(/dashboard-has-questions/);
    expect(out).toMatch(/Lint complete: [1-9]/);
  });

  it('rejects a malformed spec without running rules', async () => {
    const ctx = makeFakeActionContext({});
    const out = await handleDashboardLint(ctx, { spec: { panels: 'not-an-array' } });
    expect(out).toMatch(/Error/);
  });

  it('runs query-execution rules through the configured metrics adapter', async () => {
    const instantQuery = vi.fn().mockResolvedValue([]); // empty → triggers panel-returns-data
    const reg = new AdapterRegistry();
    reg.register({
      info: { id: 'prom', name: 'prom', type: 'prometheus', signalType: 'metrics' },
      metrics: {
        instantQuery,
        listLabels: vi.fn().mockResolvedValue([]),
        listLabelValues: vi.fn().mockResolvedValue([]),
        findSeries: vi.fn().mockResolvedValue([]),
      } as never,
    });
    const ctx = makeFakeActionContext({
      adapters: reg,
      allConnectors: [{ id: 'prom', type: 'prometheus', isDefault: true } as never],
    });
    const out = await handleDashboardLint(ctx, { spec: mkSpec() });
    expect(instantQuery).toHaveBeenCalled();
    expect(out).toMatch(/panel-returns-data/);
  });
});
