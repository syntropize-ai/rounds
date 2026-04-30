import { describe, it, expect, vi } from 'vitest';
import {
  handleDashboardCreate,
  handleDashboardClone,
  handleDashboardSetTitle,
  handleDashboardAddPanels,
  handleDashboardRemovePanels,
  handleDashboardModifyPanel,
  handleDashboardAddVariable,
  handleDashboardList,
} from '../dashboard.js';
import { makeFakeActionContext } from '../_test-helpers.js';
import { makeTestIdentity } from '../../test-helpers.js';

describe('dashboard handlers', () => {
  describe('handleDashboardCreate', () => {
    it('creates a dashboard scoped to the caller orgId and emits tool_call/result', async () => {
      const create = vi.fn().mockResolvedValue({
        id: 'dash-1',
        title: 'My Dashboard',
      });
      const ctx = makeFakeActionContext({
        store: { create, findById: vi.fn(), update: vi.fn(), updatePanels: vi.fn(), updateVariables: vi.fn() } as never,
        identity: makeTestIdentity({ orgId: 'org-7' }),
      });

      const observation = await handleDashboardCreate(ctx, { title: 'My Dashboard', datasourceId: 'prom-test' });

      expect(create).toHaveBeenCalledWith(
        expect.objectContaining({
          title: 'My Dashboard',
          workspaceId: 'org-7',
        }),
      );
      expect(observation).toContain('Created dashboard "My Dashboard"');
      expect(ctx.setNavigateTo).toHaveBeenCalledWith('/dashboards/dash-1');
      expect(ctx.sendEvent).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'tool_call', tool: 'dashboard_create' }),
      );
      expect(ctx.sendEvent).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'tool_result', tool: 'dashboard_create', success: true }),
      );
    });

    it('returns an error string when the store does not support creation', async () => {
      const ctx = makeFakeActionContext({
        store: { findById: vi.fn(), update: vi.fn(), updatePanels: vi.fn(), updateVariables: vi.fn() } as never,
      });
      const observation = await handleDashboardCreate(ctx, { title: 'X', datasourceId: 'prom-test' });
      expect(observation).toMatch(/does not support creation/);
      // No SSE events should have been emitted on the early-return branch.
      expect(ctx.sendEvent).not.toHaveBeenCalled();
    });

    it('emits tool_result with success: false and rethrows when the store create throws', async () => {
      const create = vi.fn().mockRejectedValue(new Error('db down'));
      const ctx = makeFakeActionContext({
        store: { create, findById: vi.fn(), update: vi.fn(), updatePanels: vi.fn(), updateVariables: vi.fn() } as never,
      });
      await expect(handleDashboardCreate(ctx, { title: 'X', datasourceId: 'prom-test' })).rejects.toThrow('db down');
      expect(ctx.sendEvent).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'tool_result', tool: 'dashboard_create', success: false, summary: 'db down' }),
      );
    });
  });

  describe('handleDashboardSetTitle', () => {
    it('delegates to actionExecutor and reports the new title', async () => {
      const ctx = makeFakeActionContext();
      const observation = await handleDashboardSetTitle(ctx, {
        dashboardId: 'd1',
        title: 'New Name',
      });
      expect(ctx.actionExecutor.execute).toHaveBeenCalledWith('d1', [
        { type: 'set_title', title: 'New Name' },
      ]);
      expect(observation).toBe('Title set to "New Name".');
    });

    it('returns a validation error when title is missing', async () => {
      const ctx = makeFakeActionContext();
      const observation = await handleDashboardSetTitle(ctx, { dashboardId: 'd1' });
      expect(observation).toMatch(/"title" is required/);
      expect(ctx.actionExecutor.execute).not.toHaveBeenCalled();
    });
  });

  describe('handleDashboardAddPanels', () => {
    it('adds panels and streams a panel_added event for each', async () => {
      const ctx = makeFakeActionContext();
      const observation = await handleDashboardAddPanels(ctx, {
        dashboardId: 'd1',
        panels: [{ title: 'p1', visualization: 'time_series', queries: [] }],
      });
      expect(ctx.actionExecutor.execute).toHaveBeenCalledWith('d1', [
        expect.objectContaining({ type: 'add_panels' }),
      ]);
      expect(observation).toContain('Added 1 panel(s): p1');
      const panelAdded = ctx.sendEvent.mock.calls.find(
        ([e]) => (e as { type: string }).type === 'panel_added',
      );
      expect(panelAdded).toBeDefined();
    });

    it('returns an error when panels array is empty', async () => {
      const ctx = makeFakeActionContext();
      const observation = await handleDashboardAddPanels(ctx, {
        dashboardId: 'd1',
        panels: [],
      });
      expect(observation).toMatch(/"panels" array is required/);
      expect(ctx.actionExecutor.execute).not.toHaveBeenCalled();
    });
  });

  describe('handleDashboardRemovePanels', () => {
    it('removes the listed panels and streams panel_removed events', async () => {
      const ctx = makeFakeActionContext();
      const observation = await handleDashboardRemovePanels(ctx, {
        dashboardId: 'd1',
        panelIds: ['p1', 'p2'],
      });
      expect(observation).toBe('Removed 2 panel(s).');
      const removedTypes = ctx.sendEvent.mock.calls
        .map(([e]) => (e as { type: string }).type)
        .filter((t) => t === 'panel_removed');
      expect(removedTypes).toHaveLength(2);
    });
  });

  describe('handleDashboardModifyPanel', () => {
    it('forwards the patch to actionExecutor and emits panel_modified', async () => {
      const ctx = makeFakeActionContext();
      const observation = await handleDashboardModifyPanel(ctx, {
        dashboardId: 'd1',
        panelId: 'p1',
        title: 'Renamed',
      });
      expect(observation).toBe('Modified panel p1.');
      const modified = ctx.sendEvent.mock.calls.find(
        ([e]) => (e as { type: string }).type === 'panel_modified',
      );
      expect(modified).toBeDefined();
    });
  });

  describe('handleDashboardAddVariable', () => {
    it('adds the variable and emits a tool_result', async () => {
      const ctx = makeFakeActionContext();
      const observation = await handleDashboardAddVariable(ctx, {
        dashboardId: 'd1',
        name: 'env',
        type: 'custom',
      });
      expect(observation).toBe('Added variable $env.');
      expect(ctx.actionExecutor.execute).toHaveBeenCalled();
    });
  });

  describe('handleDashboardClone', () => {
    it('clones a dashboard, rewriting every query datasourceId to the target', async () => {
      const sourcePanels = [
        {
          id: 'src-panel-1',
          title: 'p1',
          description: '',
          visualization: 'time_series',
          row: 0, col: 0, width: 6, height: 3,
          queries: [
            { refId: 'A', expr: 'up', datasourceId: 'prom-staging' },
            { refId: 'B', expr: 'down', datasourceId: 'prom-staging' },
          ],
        },
        {
          id: 'src-panel-2',
          title: 'p2',
          description: '',
          visualization: 'stat',
          row: 0, col: 6, width: 6, height: 3,
          queries: [
            { refId: 'A', expr: 'rate(http_requests_total[5m])', datasourceId: 'other' },
            { refId: 'B', expr: 'sum(rate(errors[5m]))' },
          ],
        },
      ];
      const sourceVariables = [
        { name: 'env', label: 'env', type: 'custom' as const, options: ['a', 'b'], current: 'a' },
      ];
      const findById = vi.fn().mockResolvedValue({
        id: 'src-1',
        title: 'Original',
        description: 'desc',
        prompt: 'orig prompt',
        panels: sourcePanels,
        variables: sourceVariables,
      });
      const create = vi.fn().mockResolvedValue({ id: 'new-1', title: 'Original (cloned)' });
      const updatePanels = vi.fn().mockResolvedValue(undefined);
      const updateVariables = vi.fn().mockResolvedValue(undefined);
      const updateStatus = vi.fn().mockResolvedValue(undefined);
      const ctx = makeFakeActionContext({
        store: {
          create,
          findById,
          update: vi.fn(),
          updatePanels,
          updateVariables,
          updateStatus,
        } as never,
        identity: makeTestIdentity({ orgId: 'org-9' }),
      });

      const observation = await handleDashboardClone(ctx, {
        sourceDashboardId: 'src-1',
        targetDatasourceId: 'prom-prod',
      });

      // Source was loaded
      expect(findById).toHaveBeenCalledWith('src-1');
      // New shell created with target datasource as primary
      expect(create).toHaveBeenCalledWith(
        expect.objectContaining({
          title: 'Original (cloned)',
          datasourceIds: ['prom-prod'],
          workspaceId: 'org-9',
        }),
      );

      // Every query.datasourceId is rewritten to the target
      const persistedPanels = updatePanels.mock.calls[0]![1] as Array<{
        id: string;
        queries: Array<{ datasourceId: string }>;
      }>;
      expect(persistedPanels).toHaveLength(2);
      for (const p of persistedPanels) {
        for (const q of p.queries) {
          expect(q.datasourceId).toBe('prom-prod');
        }
      }
      // New panel ids are minted (not the source ids)
      expect(persistedPanels[0]!.id).not.toBe('src-panel-1');
      expect(persistedPanels[1]!.id).not.toBe('src-panel-2');

      // Variables persisted verbatim
      expect(updateVariables).toHaveBeenCalledWith('new-1', sourceVariables);

      // Observation message + navigation
      expect(observation).toContain('Cloned "Original" (2 panels)');
      expect(observation).toContain('prom-prod');
      expect(ctx.setNavigateTo).toHaveBeenCalledWith('/dashboards/new-1');
    });

    it('uses a custom newTitle when provided', async () => {
      const findById = vi.fn().mockResolvedValue({
        id: 'src-1', title: 'Original', description: '', prompt: '', panels: [], variables: [],
      });
      const create = vi.fn().mockResolvedValue({ id: 'new-1', title: 'My Copy' });
      const ctx = makeFakeActionContext({
        store: {
          create, findById,
          update: vi.fn(), updatePanels: vi.fn(), updateVariables: vi.fn(),
        } as never,
      });
      await handleDashboardClone(ctx, {
        sourceDashboardId: 'src-1',
        targetDatasourceId: 'prom-prod',
        newTitle: 'My Copy',
      });
      expect(create).toHaveBeenCalledWith(expect.objectContaining({ title: 'My Copy' }));
    });

    it('returns an error when the source dashboard is not found', async () => {
      const findById = vi.fn().mockResolvedValue(undefined);
      const create = vi.fn();
      const ctx = makeFakeActionContext({
        store: { create, findById, update: vi.fn(), updatePanels: vi.fn(), updateVariables: vi.fn() } as never,
      });
      const observation = await handleDashboardClone(ctx, {
        sourceDashboardId: 'missing',
        targetDatasourceId: 'prom-prod',
      });
      expect(observation).toMatch(/source dashboard missing not found/);
      expect(create).not.toHaveBeenCalled();
    });

    it('errors when sourceDashboardId or targetDatasourceId is missing', async () => {
      const ctx = makeFakeActionContext();
      await expect(handleDashboardClone(ctx, { targetDatasourceId: 'x' })).resolves.toMatch(/sourceDashboardId/);
      await expect(handleDashboardClone(ctx, { sourceDashboardId: 'x' })).resolves.toMatch(/targetDatasourceId/);
    });
  });

  describe('handleDashboardList', () => {
    it('returns an error when listing fails', async () => {
      const findAll = vi.fn().mockRejectedValue(new Error('store offline'));
      const ctx = makeFakeActionContext({
        store: {
          findAll,
          findById: vi.fn(),
          update: vi.fn(),
          updatePanels: vi.fn(),
          updateVariables: vi.fn(),
        } as never,
      });
      const observation = await handleDashboardList(ctx, {});
      expect(observation).toMatch(/Failed to list dashboards: store offline/);
      expect(ctx.sendEvent).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'tool_result', tool: 'dashboard_list', success: false }),
      );
    });
  });
});
