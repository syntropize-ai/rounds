import { describe, expect, it, vi } from 'vitest';
import type { Investigation } from '@agentic-obs/common';
import { handleInvestigationComplete } from './investigation.js';
import { makeFakeActionContext } from './_test-helpers.js';

function investigationStore(workspaceId = 'test-org') {
  const investigation: Investigation = {
    id: 'inv_1',
    sessionId: 'ses_1',
    userId: 'test-user',
    intent: 'why slow',
    structuredIntent: {} as Investigation['structuredIntent'],
    plan: {
      entity: 'api',
      objective: 'why slow',
      steps: [],
      stopConditions: [],
    },
    status: 'investigating',
    hypotheses: [],
    actions: [],
    evidence: [],
    symptoms: [],
    workspaceId,
    createdAt: '2026-04-26T00:00:00.000Z',
    updatedAt: '2026-04-26T00:00:00.000Z',
  };
  return {
    create: vi.fn(),
    findAll: vi.fn(async () => [investigation]),
    updateStatus: vi.fn(),
    updatePlan: vi.fn(),
    updateResult: vi.fn(),
  };
}

describe('investigation handlers', () => {
  it('does not save or navigate when completing an unknown investigation', async () => {
    const store = investigationStore();
    vi.mocked(store.findAll).mockResolvedValue([]);
    const reportStore = { save: vi.fn() };
    const ctx = makeFakeActionContext({
      investigationStore: store,
      investigationReportStore: reportStore,
    });

    const result = await handleInvestigationComplete(ctx, {
      investigationId: 'inv_missing',
      summary: 'done',
    });

    expect(result).toContain('was not found');
    expect(reportStore.save).not.toHaveBeenCalled();
    expect(store.updateStatus).not.toHaveBeenCalled();
    expect(ctx.setNavigateTo).not.toHaveBeenCalled();
  });

  it('does not save or navigate when completing another workspace investigation', async () => {
    const store = investigationStore('other-org');
    const reportStore = { save: vi.fn() };
    const ctx = makeFakeActionContext({
      investigationStore: store,
      investigationReportStore: reportStore,
    });

    const result = await handleInvestigationComplete(ctx, {
      investigationId: 'inv_1',
      summary: 'done',
    });

    expect(result).toContain('was not found');
    expect(reportStore.save).not.toHaveBeenCalled();
    expect(store.updateStatus).not.toHaveBeenCalled();
    expect(ctx.setNavigateTo).not.toHaveBeenCalled();
  });

  it('saves and navigates only for an owned investigation', async () => {
    const store = investigationStore();
    const reportStore = { save: vi.fn() };
    const ctx = makeFakeActionContext({
      investigationStore: store,
      investigationReportStore: reportStore,
    });

    const result = await handleInvestigationComplete(ctx, {
      investigationId: 'inv_1',
      summary: 'done',
    });

    expect(result).toContain('report saved');
    expect(reportStore.save).toHaveBeenCalledOnce();
    expect(store.updateStatus).toHaveBeenCalledWith('inv_1', 'completed');
    expect(ctx.setNavigateTo).toHaveBeenCalledWith('/investigations/inv_1');
  });
});
