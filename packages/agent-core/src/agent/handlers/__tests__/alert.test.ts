/**
 * Tests for the alert_rule_write handler's preview/backtest summary.
 *
 * The full handler exercises a lot of surface (folder resolution, RBAC,
 * upsert lookup); these tests focus on the new contract introduced by
 * Task 08:
 *   1. When a metrics datasource is registered, the create-op observation
 *      string includes a "would have fired N times" preview line.
 *   2. When no metrics datasource is wired, the preview is silently omitted
 *      (no fabrication).
 */

import { describe, it, expect, vi } from 'vitest';
import { handleAlertRuleWrite } from '../alert.js';
import { makeFakeActionContext } from '../_test-helpers.js';
import { AdapterRegistry } from '../../../adapters/registry.js';
import type { IMetricsAdapter } from '@agentic-obs/adapters';

function fakeMetricsAdapter(values: Array<[number, string]>): IMetricsAdapter {
  return {
    listMetricNames: vi.fn(),
    listLabels: vi.fn(),
    listLabelValues: vi.fn(),
    findSeries: vi.fn(),
    fetchMetadata: vi.fn(),
    instantQuery: vi.fn(),
    rangeQuery: vi.fn(async () => [{ metric: { __name__: 'up' }, values }]),
    testQuery: vi.fn(),
    isHealthy: vi.fn(),
  } as unknown as IMetricsAdapter;
}

function fakeAgentCtxBase(opts: { adapters?: AdapterRegistry } = {}) {
  const created = {
    id: 'rule-1',
    name: 'HighErrorRate',
    severity: 'high',
    evaluationIntervalSec: 60,
    condition: { query: 'up', operator: '>', threshold: 0.5, forDurationSec: 0 },
  };
  const alertRuleStore = {
    create: vi.fn(async () => created),
    findById: vi.fn(),
    findByWorkspace: vi.fn(async () => []),
    update: vi.fn(),
    delete: vi.fn(),
  } as never;
  const folderRepository = {
    create: vi.fn(),
    findByUid: vi.fn(async () => ({ uid: 'alerts' })),
  } as never;
  const alertRuleAgent = {
    generate: vi.fn(async () => ({
      rule: {
        name: 'HighErrorRate',
        description: '',
        condition: { query: 'up', operator: '>', threshold: 0.5, forDurationSec: 0 },
        evaluationIntervalSec: 60,
        severity: 'high',
        labels: {},
      },
    })),
  } as never;
  const ctx = makeFakeActionContext({
    alertRuleStore,
    folderRepository,
    alertRuleAgent,
    ...(opts.adapters ? { adapters: opts.adapters } : {}),
  });
  return { ctx, alertRuleStore, alertRuleAgent };
}

describe('alert_rule_write op=create — preview summary', () => {
  it('includes preview "would have fired" line when a metrics datasource is registered', async () => {
    const adapter = fakeMetricsAdapter([
      [1_700_000_000, '0.1'],
      [1_700_000_060, '0.9'],
      [1_700_000_120, '0.95'],
    ]);
    const adapters = new AdapterRegistry();
    adapters.register({
      info: { id: 'prom', name: 'prom', type: 'prometheus', signalType: 'metrics', isDefault: true },
      metrics: adapter,
    });
    const { ctx } = fakeAgentCtxBase({ adapters });

    const observation = await handleAlertRuleWrite(ctx, { op: 'create', prompt: 'alert when up > 0.5' });

    expect(observation).toContain('Created alert rule "HighErrorRate"');
    expect(observation).toContain('Preview: would have fired 2 time(s) across 1 series in the last 24h.');
  });

  it('omits the preview line when no metrics datasource is registered (no fabrication)', async () => {
    const { ctx } = fakeAgentCtxBase({ adapters: new AdapterRegistry() });

    const observation = await handleAlertRuleWrite(ctx, { op: 'create', prompt: 'alert when up > 0.5' });

    expect(observation).toContain('Created alert rule "HighErrorRate"');
    expect(observation).not.toContain('Preview:');
    expect(observation).not.toContain('would have fired');
  });
});
