/**
 * Handler integration tests for the persisted pending_changes path.
 *
 * Verifies that mutation handlers — when ctx.pendingChanges is wired —
 * write a row, emit `pending_change_created`, and leave the dashboard
 * untouched. The legacy ephemeral path is covered in dashboard.test.ts.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  handleDashboardModifyPanel,
  handleDashboardRemovePanels,
  handleDashboardSetTitle,
  handleDashboardAddVariable,
} from '../dashboard.js';
import { makeFakeActionContext } from '../_test-helpers.js';
import type { IPendingChangeRepository, PendingChange } from '@agentic-obs/data-layer';

function makeRepo(): { repo: IPendingChangeRepository; rows: PendingChange[] } {
  const rows: PendingChange[] = [];
  const repo: IPendingChangeRepository = {
    insert: vi.fn(async (input) => {
      const row: PendingChange = {
        id: input.id,
        orgId: input.orgId,
        dashboardId: input.dashboardId,
        panelId: input.panelId,
        proposedBy: input.proposedBy,
        proposedAt: input.proposedAt,
        status: input.status ?? 'pending',
        resolvedAt: null,
        resolvedBy: null,
        changeKind: input.changeKind,
        beforeJson: input.beforeJson,
        afterJson: input.afterJson,
        summary: input.summary,
        expiresAt: input.expiresAt,
      };
      rows.push(row);
      return row;
    }),
    getById: vi.fn(),
    listByDashboard: vi.fn(),
    countByOrg: vi.fn(),
    countByOrgGrouped: vi.fn(),
    resolve: vi.fn(),
    expireOlderThan: vi.fn(),
  };
  return { repo, rows };
}

describe('dashboard handlers persist to pending_changes when wired', () => {
  it('modify_panel writes a row, emits pending_change_created, leaves dashboard untouched', async () => {
    const { repo, rows } = makeRepo();
    const ctx = makeFakeActionContext({
      activeDashboardId: 'd-shared',
      pendingChanges: repo,
    });
    const observation = await handleDashboardModifyPanel(ctx, { panelId: 'p1', title: 'Renamed' });

    expect(observation).toMatch(/Pending user approval/);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.changeKind).toBe('modify_panel');
    expect(rows[0]!.panelId).toBe('p1');
    expect(rows[0]!.proposedBy).toBe('agent:test-session');
    expect(ctx.actionExecutor.execute).not.toHaveBeenCalled();

    const created = ctx.sendEvent.mock.calls.find(
      ([e]) => (e as { type: string }).type === 'pending_change_created',
    );
    expect(created).toBeDefined();
    const modified = ctx.sendEvent.mock.calls.find(
      ([e]) => (e as { type: string }).type === 'panel_modified',
    );
    expect(modified).toBeUndefined();
  });

  it('remove_panels persists one row per panel id', async () => {
    const { repo, rows } = makeRepo();
    const ctx = makeFakeActionContext({
      activeDashboardId: 'd-shared',
      pendingChanges: repo,
    });
    await handleDashboardRemovePanels(ctx, { panelIds: ['p1', 'p2'] });
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.changeKind)).toEqual(['remove_panel', 'remove_panel']);
    expect(rows.map((r) => r.panelId)).toEqual(['p1', 'p2']);
    expect(ctx.actionExecutor.execute).not.toHaveBeenCalled();
  });

  it('set_title persists when dashboard pre-existed', async () => {
    const { repo, rows } = makeRepo();
    const ctx = makeFakeActionContext({
      activeDashboardId: 'd-shared',
      pendingChanges: repo,
    });
    const observation = await handleDashboardSetTitle(ctx, { title: 'New Title' });
    expect(observation).toMatch(/Pending user approval/);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.changeKind).toBe('set_title');
    expect((rows[0]!.afterJson as { title: string }).title).toBe('New Title');
    expect(ctx.actionExecutor.execute).not.toHaveBeenCalled();
  });

  it('add_variable persists when dashboard pre-existed', async () => {
    const { repo, rows } = makeRepo();
    const ctx = makeFakeActionContext({
      activeDashboardId: 'd-shared',
      pendingChanges: repo,
    });
    const observation = await handleDashboardAddVariable(ctx, { name: 'env', type: 'custom' });
    expect(observation).toMatch(/Pending user approval/);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.changeKind).toBe('add_variable');
    expect(rows[0]!.panelId).toBeNull();
    expect(ctx.actionExecutor.execute).not.toHaveBeenCalled();
  });

  it('freshly-created dashboard still applies directly (no row written)', async () => {
    const { repo, rows } = makeRepo();
    const ctx = makeFakeActionContext({
      activeDashboardId: 'd-new',
      freshlyCreatedDashboards: new Set(['d-new']),
      pendingChanges: repo,
    });
    await handleDashboardModifyPanel(ctx, { panelId: 'p1', title: 'X' });
    expect(rows).toHaveLength(0);
    expect(ctx.actionExecutor.execute).toHaveBeenCalled();
  });
});
