import { describe, it, expect, vi } from 'vitest';
import {
  handleDashboardCreate,
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

      const observation = await handleDashboardCreate(ctx, { title: 'My Dashboard' });

      expect(create).toHaveBeenCalledWith(
        expect.objectContaining({
          title: 'My Dashboard',
          workspaceId: 'org-7',
        }),
      );
      expect(observation).toContain('Created dashboard "My Dashboard"');
      expect(ctx.setNavigateTo).toHaveBeenCalledWith('/dashboards/dash-1');
      expect(ctx.sendEvent).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'tool_call', tool: 'dashboard.create' }),
      );
      expect(ctx.sendEvent).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'tool_result', tool: 'dashboard.create', success: true }),
      );
    });

    it('returns an error string when the store does not support creation', async () => {
      const ctx = makeFakeActionContext({
        store: { findById: vi.fn(), update: vi.fn(), updatePanels: vi.fn(), updateVariables: vi.fn() } as never,
      });
      const observation = await handleDashboardCreate(ctx, { title: 'X' });
      expect(observation).toMatch(/does not support creation/);
      // No SSE events should have been emitted on the early-return branch.
      expect(ctx.sendEvent).not.toHaveBeenCalled();
    });

    it('emits tool_result with success: false and rethrows when the store create throws', async () => {
      const create = vi.fn().mockRejectedValue(new Error('db down'));
      const ctx = makeFakeActionContext({
        store: { create, findById: vi.fn(), update: vi.fn(), updatePanels: vi.fn(), updateVariables: vi.fn() } as never,
      });
      await expect(handleDashboardCreate(ctx, { title: 'X' })).rejects.toThrow('db down');
      expect(ctx.sendEvent).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'tool_result', tool: 'dashboard.create', success: false, summary: 'db down' }),
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
        expect.objectContaining({ type: 'tool_result', tool: 'dashboard.list', success: false }),
      );
    });
  });
});
