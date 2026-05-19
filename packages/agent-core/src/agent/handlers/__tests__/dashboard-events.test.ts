/**
 * Tests for the agent-side panel_events emission hook.
 *
 * Mirrors what the Express dashboard route does for user CRUD, but invoked
 * from inside the agent's dashboard handlers so agent-only sessions (which
 * bypass POST /api/dashboards) still produce panel_events rows.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  handleDashboardAddPanels,
  handleDashboardRemovePanels,
  handleDashboardModifyPanel,
} from '../dashboard.js';
import { makeFakeActionContext } from '../_test-helpers.js';
import type { IPanelEventRepository, PanelEventInput } from '../../panel-event-recorder.js';

function makeFakePanelEvents(): {
  repo: IPanelEventRepository;
  records: PanelEventInput[];
  waitForRecords: (n: number, timeoutMs?: number) => Promise<void>;
} {
  const records: PanelEventInput[] = [];
  const repo: IPanelEventRepository = {
    record: async (input) => {
      records.push(input);
      return { id: `pe-${records.length}` };
    },
  };
  async function waitForRecords(n: number, timeoutMs = 200): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (records.length < n && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 5));
    }
  }
  return { repo, records, waitForRecords };
}

describe('dashboard handlers — panel_events fire-and-forget hook', () => {
  it('handleDashboardAddPanels emits one "created" event per panel', async () => {
    const { repo, records, waitForRecords } = makeFakePanelEvents();
    // Disable verify-gate so we exercise the handler's panel-event branch
    // without standing up an adapter registry.
    const prev = process.env['DASHBOARD_VERIFY_GATE'];
    process.env['DASHBOARD_VERIFY_GATE'] = '0';
    try {
      const ctx = makeFakeActionContext({
        activeDashboardId: 'dash-1',
        freshlyCreatedDashboards: new Set(['dash-1']),
        panelEvents: repo,
      });
      ctx.dashboardBuildEvidence.webSearchCount = 1;
      ctx.dashboardBuildEvidence.validatedQueries.add('up');
      ctx.dashboardBuildEvidence.validatedQueries.add('sum(rate(x[5m]))');

      const out = await handleDashboardAddPanels(ctx, {
        panels: [
          {
            title: 'P1',
            description: 'Q: is it up?',
            visualization: 'stat',
            queries: [{ refId: 'A', expr: 'up', datasourceId: 'prom' }],
          },
          {
            title: 'P2',
            description: 'Q: rate?',
            visualization: 'time_series',
            queries: [{ refId: 'A', expr: 'sum(rate(x[5m]))', datasourceId: 'prom' }],
          },
        ],
      });
      expect(out).toContain('Added 2 panel');

      await waitForRecords(2);
      expect(records).toHaveLength(2);
      const types = records.map((r) => r.eventType);
      expect(types).toEqual(['created', 'created']);
      for (const r of records) {
        expect(r.dashboardId).toBe('dash-1');
        expect(r.aiGenerated).toBe(true);
        expect(r.sessionId).toBe('test-session');
        expect(r.panelId).toBeTruthy();
      }
    } finally {
      if (prev === undefined) delete process.env['DASHBOARD_VERIFY_GATE'];
      else process.env['DASHBOARD_VERIFY_GATE'] = prev;
    }
  });

  it('handleDashboardRemovePanels emits one "deleted" event per id', async () => {
    const { repo, records, waitForRecords } = makeFakePanelEvents();
    const findById = vi.fn().mockResolvedValue({
      id: 'dash-1',
      panels: [
        { id: 'pa', title: 'P A', visualization: 'time_series', queries: [{ expr: 'up' }] },
        { id: 'pb', title: 'P B', visualization: 'stat', queries: [{ expr: 'down' }] },
      ],
    });
    const ctx = makeFakeActionContext({
      activeDashboardId: 'dash-1',
      freshlyCreatedDashboards: new Set(['dash-1']),
      panelEvents: repo,
      store: { findById, updatePanels: vi.fn(), updateVariables: vi.fn() } as never,
    });

    await handleDashboardRemovePanels(ctx, { panelIds: ['pa', 'pb'] });

    await waitForRecords(2);
    expect(records.map((r) => r.eventType)).toEqual(['deleted', 'deleted']);
    expect(records.map((r) => r.panelId).sort()).toEqual(['pa', 'pb']);
  });

  it('handleDashboardModifyPanel emits a single "edited" event', async () => {
    const { repo, records, waitForRecords } = makeFakePanelEvents();
    const ctx = makeFakeActionContext({
      activeDashboardId: 'dash-1',
      freshlyCreatedDashboards: new Set(['dash-1']),
      panelEvents: repo,
    });
    await handleDashboardModifyPanel(ctx, { panelId: 'pa', title: 'renamed' });

    await waitForRecords(1);
    expect(records).toHaveLength(1);
    expect(records[0]!.eventType).toBe('edited');
    expect(records[0]!.panelId).toBe('pa');
  });
});
