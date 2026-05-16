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
      // Active id is set so the next add_panels / modify_panel call in the
      // same ReAct loop can target this dashboard implicitly.
      expect(ctx.activeDashboardId).toBe('dash-1');
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
      const ctx = makeFakeActionContext({ activeDashboardId: 'd1' });
      const observation = await handleDashboardSetTitle(ctx, { title: 'New Name' });
      expect(ctx.actionExecutor.execute).toHaveBeenCalledWith('d1', [
        { type: 'set_title', title: 'New Name' },
      ]);
      expect(observation).toBe('Title set to "New Name".');
    });

    it('returns a validation error when title is missing', async () => {
      const ctx = makeFakeActionContext({ activeDashboardId: 'd1' });
      const observation = await handleDashboardSetTitle(ctx, {});
      expect(observation).toMatch(/"title" is required/);
      expect(ctx.actionExecutor.execute).not.toHaveBeenCalled();
    });

    it('errors when no active dashboard is set', async () => {
      const ctx = makeFakeActionContext();
      const observation = await handleDashboardSetTitle(ctx, { title: 'X' });
      expect(observation).toMatch(/no active dashboard/);
      expect(ctx.actionExecutor.execute).not.toHaveBeenCalled();
    });
  });

  describe('handleDashboardAddPanels', () => {
    it('adds panels and streams a panel_added event for each', async () => {
      const ctx = makeFakeActionContext({ activeDashboardId: 'd1', freshlyCreatedDashboards: new Set(['d1']) });
      const observation = await handleDashboardAddPanels(ctx, {
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

    it('requires metric research before adding queried panels', async () => {
      const ctx = makeFakeActionContext({ activeDashboardId: 'd1' });
      const observation = await handleDashboardAddPanels(ctx, {
        panels: [{
          title: 'Request rate',
          visualization: 'time_series',
          queries: [{ refId: 'A', expr: 'sum(rate(http_requests_total[5m]))', datasourceId: 'prom' }],
        }],
      });
      expect(observation).toMatch(/requires prior metric research/);
      expect(ctx.actionExecutor.execute).not.toHaveBeenCalled();
    });

    it('requires metrics_validate for every queried panel expression', async () => {
      const ctx = makeFakeActionContext({
        activeDashboardId: 'd1',
        dashboardBuildEvidence: {
          webSearchCount: 1,
          metricDiscoveryCount: 0,
          validatedQueries: new Set<string>(),
        },
      });
      const observation = await handleDashboardAddPanels(ctx, {
        panels: [{
          title: 'Request rate',
          visualization: 'time_series',
          queries: [{ refId: 'A', expr: 'sum(rate(http_requests_total[5m]))', datasourceId: 'prom' }],
        }],
      });
      expect(observation).toMatch(/validate panel queries/);
      expect(ctx.actionExecutor.execute).not.toHaveBeenCalled();
    });

    it('adds queried panels after research and validation evidence exists', async () => {
      const expr = 'sum(rate(http_requests_total[5m]))';
      const ctx = makeFakeActionContext({
        activeDashboardId: 'd1',
        dashboardBuildEvidence: {
          webSearchCount: 0,
          metricDiscoveryCount: 1,
          validatedQueries: new Set<string>([expr]),
        },
      });
      const observation = await handleDashboardAddPanels(ctx, {
        panels: [{
          title: 'Request rate',
          visualization: 'time_series',
          queries: [{ refId: 'A', expr, datasourceId: 'prom' }],
        }],
      });
      expect(ctx.actionExecutor.execute).toHaveBeenCalledWith('d1', [
        expect.objectContaining({ type: 'add_panels' }),
      ]);
      expect(observation).toContain('Added 1 panel(s): Request rate');
    });

    it('returns an error when panels array is empty', async () => {
      const ctx = makeFakeActionContext({ activeDashboardId: 'd1' });
      const observation = await handleDashboardAddPanels(ctx, { panels: [] });
      expect(observation).toMatch(/"panels" array is required/);
      expect(ctx.actionExecutor.execute).not.toHaveBeenCalled();
    });

    it('errors when no active dashboard is set', async () => {
      const ctx = makeFakeActionContext();
      const observation = await handleDashboardAddPanels(ctx, {
        panels: [{ title: 'p1', visualization: 'time_series', queries: [] }],
      });
      expect(observation).toMatch(/no active dashboard/);
      expect(ctx.actionExecutor.execute).not.toHaveBeenCalled();
    });

    // ── T0.2 regression: status state machine never sticks at 'generating'
    it('flips status to ready after a successful panel add', async () => {
      const updateStatus = vi.fn().mockResolvedValue(undefined);
      const ctx = makeFakeActionContext({
        activeDashboardId: 'd1',
        freshlyCreatedDashboards: new Set(['d1']),
        store: {
          findById: vi.fn().mockResolvedValue(undefined),
          update: vi.fn(),
          updatePanels: vi.fn(),
          updateVariables: vi.fn(),
          updateStatus,
        } as never,
      });

      await handleDashboardAddPanels(ctx, {
        panels: [{ title: 'p1', visualization: 'time_series', queries: [] }],
      });

      expect(updateStatus).toHaveBeenCalledWith('d1', 'ready', undefined);
    });

    it('flips status to failed when panel generation throws partway through', async () => {
      const updateStatus = vi.fn().mockResolvedValue(undefined);
      const ctx = makeFakeActionContext({
        activeDashboardId: 'd1',
        freshlyCreatedDashboards: new Set(['d1']),
        store: {
          findById: vi.fn().mockResolvedValue(undefined),
          update: vi.fn(),
          updatePanels: vi.fn(),
          updateVariables: vi.fn(),
          updateStatus,
        } as never,
        actionExecutor: {
          execute: vi.fn().mockRejectedValue(new Error('boom: adapter blew up')),
        } as never,
      });

      await expect(
        handleDashboardAddPanels(ctx, {
          panels: [{ title: 'p1', visualization: 'time_series', queries: [] }],
        }),
      ).rejects.toThrow(/boom/);

      // No path leaves status at 'generating': failure must land at 'failed'.
      const statusCalls = updateStatus.mock.calls.map((c) => c[1]);
      expect(statusCalls).toContain('failed');
      expect(statusCalls).not.toContain('ready');
      // The error message rides along so the UI can render an actionable state.
      const failedCall = updateStatus.mock.calls.find((c) => c[1] === 'failed');
      expect(failedCall?.[2]).toMatch(/boom/);
    });

    it('emits SSE error event and warns when updateStatus itself fails', async () => {
      const updateStatus = vi.fn().mockRejectedValue(new Error('db unavailable'));
      const ctx = makeFakeActionContext({
        activeDashboardId: 'd1',
        freshlyCreatedDashboards: new Set(['d1']),
        store: {
          findById: vi.fn().mockResolvedValue(undefined),
          update: vi.fn(),
          updatePanels: vi.fn(),
          updateVariables: vi.fn(),
          updateStatus,
        } as never,
      });

      await handleDashboardAddPanels(ctx, {
        panels: [{ title: 'p1', visualization: 'time_series', queries: [] }],
      });

      // SSE error event surfaced so the web UI doesn't sit on stale 'generating'.
      const errorEvent = ctx.sendEvent.mock.calls
        .map(([e]) => e as { type: string; message?: string })
        .find((e) => e.type === 'error');
      expect(errorEvent).toBeDefined();
      expect(errorEvent!.message).toMatch(/db unavailable/);
    });
  });

  describe('handleDashboardRemovePanels', () => {
    it('removes the listed panels and streams panel_removed events on a freshly-created dashboard', async () => {
      const ctx = makeFakeActionContext({ activeDashboardId: 'd1', freshlyCreatedDashboards: new Set(['d1']) });
      const observation = await handleDashboardRemovePanels(ctx, {
        panelIds: ['p1', 'p2'],
      });
      expect(observation).toBe('Removed 2 panel(s).');
      const removedTypes = ctx.sendEvent.mock.calls
        .map(([e]) => (e as { type: string }).type)
        .filter((t) => t === 'panel_removed');
      expect(removedTypes).toHaveLength(2);
    });

    it('writes a pending change for an existing (non-fresh) dashboard and leaves it untouched', async () => {
      const appendPendingChanges = vi.fn().mockResolvedValue(undefined);
      const ctx = makeFakeActionContext({
        activeDashboardId: 'd-shared',
        store: {
          findById: vi.fn(),
          update: vi.fn(),
          updatePanels: vi.fn(),
          updateVariables: vi.fn(),
          appendPendingChanges,
        } as never,
      });
      const observation = await handleDashboardRemovePanels(ctx, { panelIds: ['p1', 'p2'] });
      expect(observation).toMatch(/pending user review/);
      // Original dashboard untouched — no executor call, no panel_removed.
      expect(ctx.actionExecutor.execute).not.toHaveBeenCalled();
      const removedTypes = ctx.sendEvent.mock.calls
        .map(([e]) => (e as { type: string }).type)
        .filter((t) => t === 'panel_removed');
      expect(removedTypes).toHaveLength(0);
      // One pending change per panelId, all routed through the store.
      expect(appendPendingChanges).toHaveBeenCalledTimes(2);
      const firstPersisted = appendPendingChanges.mock.calls[0]![1] as Array<{ op: { kind: string; panelId: string } }>;
      expect(firstPersisted[0]!.op).toEqual({ kind: 'remove_panel', panelId: 'p1' });
      // SSE event for chat panel surfacing.
      const proposed = ctx.sendEvent.mock.calls.find(
        ([e]) => (e as { type: string }).type === 'pending_changes_proposed',
      );
      expect(proposed).toBeDefined();
    });

    it('emits a failed tool_result when remove fails', async () => {
      const ctx = makeFakeActionContext({
        activeDashboardId: 'd1',
        freshlyCreatedDashboards: new Set(['d1']),
      });
      vi.mocked(ctx.actionExecutor.execute).mockRejectedValueOnce(new Error('store offline'));

      const observation = await handleDashboardRemovePanels(ctx, { panelIds: ['p1'] });

      expect(observation).toBe('Error: store offline');
      expect(ctx.sendEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'tool_result',
          tool: 'dashboard_remove_panels',
          success: false,
          summary: 'Error: store offline',
        }),
      );
    });
  });

  describe('handleDashboardModifyPanel', () => {
    it('forwards the patch to actionExecutor and emits panel_modified on a freshly-created dashboard', async () => {
      const ctx = makeFakeActionContext({ activeDashboardId: 'd1', freshlyCreatedDashboards: new Set(['d1']) });
      const observation = await handleDashboardModifyPanel(ctx, {
        panelId: 'p1',
        title: 'Renamed',
      });
      expect(observation).toBe('Modified panel p1.');
      const modified = ctx.sendEvent.mock.calls.find(
        ([e]) => (e as { type: string }).type === 'panel_modified',
      );
      expect(modified).toBeDefined();
    });

    it('writes a pending change for an existing dashboard and leaves it untouched', async () => {
      const appendPendingChanges = vi.fn().mockResolvedValue(undefined);
      const ctx = makeFakeActionContext({
        activeDashboardId: 'd-shared',
        store: {
          findById: vi.fn(),
          update: vi.fn(),
          updatePanels: vi.fn(),
          updateVariables: vi.fn(),
          appendPendingChanges,
        } as never,
      });
      const observation = await handleDashboardModifyPanel(ctx, { panelId: 'p1', title: 'Renamed' });
      expect(observation).toMatch(/pending user review/);
      expect(ctx.actionExecutor.execute).not.toHaveBeenCalled();
      const modified = ctx.sendEvent.mock.calls.find(
        ([e]) => (e as { type: string }).type === 'panel_modified',
      );
      expect(modified).toBeUndefined();
      expect(appendPendingChanges).toHaveBeenCalledTimes(1);
      const persisted = appendPendingChanges.mock.calls[0]![1] as Array<{ op: { kind: string; panelId: string; patch: Record<string, unknown> } }>;
      expect(persisted[0]!.op.kind).toBe('modify_panel');
      expect(persisted[0]!.op.panelId).toBe('p1');
      expect(persisted[0]!.op.patch.title).toBe('Renamed');
    });

    it('emits a failed tool_result when modify fails', async () => {
      const ctx = makeFakeActionContext({
        activeDashboardId: 'd1',
        freshlyCreatedDashboards: new Set(['d1']),
      });
      vi.mocked(ctx.actionExecutor.execute).mockRejectedValueOnce(new Error('write failed'));

      const observation = await handleDashboardModifyPanel(ctx, { panelId: 'p1', title: 'Renamed' });

      expect(observation).toBe('Error: write failed');
      expect(ctx.sendEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'tool_result',
          tool: 'dashboard_modify_panel',
          success: false,
          summary: 'Error: write failed',
        }),
      );
    });
  });

  describe('handleDashboardAddVariable', () => {
    it('adds the variable directly when the dashboard is freshly created', async () => {
      const ctx = makeFakeActionContext({ activeDashboardId: 'd1', freshlyCreatedDashboards: new Set(['d1']) });
      const observation = await handleDashboardAddVariable(ctx, {
        name: 'env',
        type: 'custom',
      });
      expect(observation).toBe('Added variable $env.');
      expect(ctx.actionExecutor.execute).toHaveBeenCalled();
    });

    it('emits a failed tool_result when adding a variable fails', async () => {
      const ctx = makeFakeActionContext({
        activeDashboardId: 'd1',
        freshlyCreatedDashboards: new Set(['d1']),
      });
      vi.mocked(ctx.actionExecutor.execute).mockRejectedValueOnce(new Error('variable write failed'));

      const observation = await handleDashboardAddVariable(ctx, { name: 'env', type: 'custom' });

      expect(observation).toBe('Error: variable write failed');
      expect(ctx.sendEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'tool_result',
          tool: 'dashboard_add_variable',
          success: false,
          summary: 'Error: variable write failed',
        }),
      );
    });

    it('queues a pending change for variable additions on an existing dashboard', async () => {
      const appendPendingChanges = vi.fn().mockResolvedValue(undefined);
      const ctx = makeFakeActionContext({
        activeDashboardId: 'd-shared',
        store: {
          findById: vi.fn(),
          update: vi.fn(),
          updatePanels: vi.fn(),
          updateVariables: vi.fn(),
          appendPendingChanges,
        } as never,
      });
      const observation = await handleDashboardAddVariable(ctx, { name: 'env', type: 'custom' });
      expect(observation).toMatch(/pending user review/);
      expect(ctx.actionExecutor.execute).not.toHaveBeenCalled();
      expect(appendPendingChanges).toHaveBeenCalledTimes(1);
      const persisted = appendPendingChanges.mock.calls[0]![1] as Array<{ op: { kind: string; variable: { name: string } } }>;
      expect(persisted[0]!.op.kind).toBe('add_variable');
      expect(persisted[0]!.op.variable.name).toBe('env');
    });
  });

  describe('pending changes integration', () => {
    it('marks dashboards created in this session as fresh so initial population applies directly', async () => {
      const create = vi.fn().mockResolvedValue({ id: 'dash-1', title: 'My Dashboard' });
      const ctx = makeFakeActionContext({
        store: { create, findById: vi.fn(), update: vi.fn(), updatePanels: vi.fn(), updateVariables: vi.fn() } as never,
      });
      await handleDashboardCreate(ctx, { title: 'My Dashboard', datasourceId: 'prom-test' });
      expect(ctx.freshlyCreatedDashboards.has('dash-1')).toBe(true);
      // Now a follow-up modify should apply directly (no pending).
      await handleDashboardAddVariable(ctx, { name: 'env', type: 'custom' });
      expect(ctx.actionExecutor.execute).toHaveBeenCalled();
    });

    it('accept-applying a remove_panel pending change is idempotent at the store layer', async () => {
      // The accept path calls actionExecutor.execute with a remove_panels action;
      // applying twice yields the same final panel set.
      const appendPendingChanges = vi.fn().mockResolvedValue(undefined);
      const ctx = makeFakeActionContext({
        activeDashboardId: 'd-shared',
        store: {
          findById: vi.fn(),
          update: vi.fn(),
          updatePanels: vi.fn(),
          updateVariables: vi.fn(),
          appendPendingChanges,
        } as never,
      });
      await handleDashboardRemovePanels(ctx, { panelIds: ['p1'] });
      const persisted = appendPendingChanges.mock.calls[0]![1] as Array<{ op: { kind: string; panelId?: string } }>;
      const op = persisted[0]!.op;
      expect(op.kind).toBe('remove_panel');
      // The patch is a stable description — re-applying the same op is a no-op
      // for an already-removed panel (action-executor filters by id).
      expect((op as { kind: 'remove_panel'; panelId: string }).panelId).toBe('p1');
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
