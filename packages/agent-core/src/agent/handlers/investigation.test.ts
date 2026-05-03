import { describe, expect, it, vi } from 'vitest';
import type { Investigation } from '@agentic-obs/common';
import {
  handleInvestigationAddSection,
  handleInvestigationComplete,
  handleInvestigationCreate,
} from './investigation.js';
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
    findById: vi.fn(async (id: string) => (id === investigation.id ? investigation : null)),
    findAll: vi.fn(async () => [investigation]),
    updateStatus: vi.fn(),
    updatePlan: vi.fn(),
    updateResult: vi.fn(),
  };
}

describe('investigation handlers', () => {
  it('does not save or navigate when completing without an active investigation', async () => {
    const store = investigationStore();
    const reportStore = { save: vi.fn() };
    const ctx = makeFakeActionContext({
      investigationStore: store,
      investigationReportStore: reportStore,
    });
    // ctx.activeInvestigationId defaults to null

    const result = await handleInvestigationComplete(ctx, { summary: 'done' });

    expect(result).toContain('no active investigation');
    expect(store.findById).not.toHaveBeenCalled();
    expect(reportStore.save).not.toHaveBeenCalled();
    expect(ctx.setNavigateTo).not.toHaveBeenCalled();
  });

  it('does not save or navigate when the active investigation belongs to another workspace', async () => {
    const store = investigationStore('other-org');
    const reportStore = { save: vi.fn() };
    const ctx = makeFakeActionContext({
      investigationStore: store,
      investigationReportStore: reportStore,
      activeInvestigationId: 'inv_1',
    });

    const result = await handleInvestigationComplete(ctx, { summary: 'done' });

    expect(result).toContain('was not found');
    expect(reportStore.save).not.toHaveBeenCalled();
    expect(store.updateStatus).not.toHaveBeenCalled();
    expect(ctx.setNavigateTo).not.toHaveBeenCalled();
  });

  it('saves, navigates, and clears active id for an owned investigation', async () => {
    const store = investigationStore();
    const reportStore = { save: vi.fn() };
    const ctx = makeFakeActionContext({
      investigationStore: store,
      investigationReportStore: reportStore,
      activeInvestigationId: 'inv_1',
    });

    const result = await handleInvestigationComplete(ctx, { summary: 'done' });

    expect(result).toContain('report saved');
    expect(reportStore.save).toHaveBeenCalledOnce();
    expect(store.updateStatus).toHaveBeenCalledWith('inv_1', 'completed');
    expect(ctx.setNavigateTo).toHaveBeenCalledWith('/investigations/inv_1');
    // active id cleared so the next investigation_create starts a fresh one
    expect(ctx.activeInvestigationId).toBeNull();
  });

  it('add_section returns an error when no active investigation', async () => {
    const ctx = makeFakeActionContext({});
    // ctx.activeInvestigationId defaults to null

    const result = await handleInvestigationAddSection(ctx, {
      type: 'text',
      content: 'a paragraph',
    });

    expect(result).toContain('no active investigation');
    expect(ctx.investigationSections.size).toBe(0);
  });

  it('add_section appends to the active investigation\'s section list', async () => {
    const ctx = makeFakeActionContext({ activeInvestigationId: 'inv_1' });

    const r1 = await handleInvestigationAddSection(ctx, {
      type: 'text',
      content: 'first paragraph',
    });
    const r2 = await handleInvestigationAddSection(ctx, {
      type: 'text',
      content: 'second paragraph',
    });

    expect(r1).toContain('1 sections total');
    expect(r2).toContain('2 sections total');
    expect(ctx.investigationSections.get('inv_1')?.length).toBe(2);
  });

  it('investigation_create sets ctx.activeInvestigationId on success', async () => {
    const created: Investigation = {
      id: 'inv_new',
      sessionId: 'ses_1',
      userId: 'agent',
      intent: 'why',
      structuredIntent: {} as Investigation['structuredIntent'],
      plan: { entity: '', objective: '', steps: [], stopConditions: [] },
      status: 'investigating',
      hypotheses: [],
      actions: [],
      evidence: [],
      symptoms: [],
      workspaceId: 'test-org',
      createdAt: '2026-04-26T00:00:00.000Z',
      updatedAt: '2026-04-26T00:00:00.000Z',
    };
    const store = {
      create: vi.fn(async () => created),
      findById: vi.fn(),
      findAll: vi.fn(),
      updateStatus: vi.fn(),
      updatePlan: vi.fn(),
      updateResult: vi.fn(),
    };
    const ctx = makeFakeActionContext({ investigationStore: store });
    expect(ctx.activeInvestigationId).toBeNull();

    await handleInvestigationCreate(ctx, { question: 'why is X slow?' });

    expect(ctx.activeInvestigationId).toBe('inv_new');
  });
});
