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

  // ── Provenance (Task 10) ────────────────────────────────────────────────

  it('seeds provenance on create and accumulates tool calls / evidence / citations', async () => {
    const created = {
      id: 'inv_p1',
      sessionId: 'ses_1',
      userId: 'agent',
      intent: 'why',
      structuredIntent: {} as Investigation['structuredIntent'],
      plan: { entity: '', objective: '', steps: [], stopConditions: [] },
      status: 'investigating' as const,
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
      findById: vi.fn(async () => created),
      findAll: vi.fn(),
      updateStatus: vi.fn(),
      updatePlan: vi.fn(),
      updateResult: vi.fn(),
    };
    const ctx = makeFakeActionContext({ investigationStore: store });
    await handleInvestigationCreate(ctx, { question: 'why' });

    const prov = ctx.investigationProvenance.get('inv_p1');
    expect(prov).toBeDefined();
    expect(prov!.runId).toBe('inv_p1');
    expect(prov!.model).toBe('test-model');
    expect(prov!.toolCalls).toBe(0);

    await handleInvestigationAddSection(ctx, {
      type: 'text',
      content: '## Symptom\nLatency spike confirmed [m1] and OOM in logs [l1].',
    });
    await handleInvestigationAddSection(ctx, {
      type: 'evidence',
      content: 'CPU saturation [m1]',
      panel: { title: 'CPU', visualization: 'time_series', queries: [] },
    });

    const after = ctx.investigationProvenance.get('inv_p1')!;
    expect(after.toolCalls).toBe(2);
    expect(after.evidenceCount).toBe(1);
    // Citations dedup by ref — m1 referenced twice → counted once.
    expect(after.citations?.map((c) => c.ref).sort()).toEqual(['l1', 'm1']);
    expect(after.citations?.find((c) => c.ref === 'm1')?.kind).toBe('metric');
    expect(after.citations?.find((c) => c.ref === 'l1')?.kind).toBe('log');
  });

  it('persists provenance on the saved report at completion', async () => {
    const created = {
      id: 'inv_p2',
      sessionId: 'ses_1',
      userId: 'agent',
      intent: 'why',
      structuredIntent: {} as Investigation['structuredIntent'],
      plan: { entity: '', objective: '', steps: [], stopConditions: [] },
      status: 'investigating' as const,
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
      findById: vi.fn(async () => created),
      findAll: vi.fn(),
      updateStatus: vi.fn(),
      updatePlan: vi.fn(),
      updateResult: vi.fn(),
    };
    const reportStore = { save: vi.fn() };
    const ctx = makeFakeActionContext({
      investigationStore: store,
      investigationReportStore: reportStore,
    });

    await handleInvestigationCreate(ctx, { question: 'why' });
    await handleInvestigationAddSection(ctx, {
      type: 'text',
      content: 'Spike [m1].',
    });
    await handleInvestigationComplete(ctx, { summary: 'CPU saturation' });

    expect(reportStore.save).toHaveBeenCalledOnce();
    const saved = (reportStore.save.mock.calls[0] ?? [])[0];
    expect(saved.provenance).toBeDefined();
    expect(saved.provenance.runId).toBe('inv_p2');
    expect(saved.provenance.toolCalls).toBe(1);
    expect(saved.provenance.evidenceCount).toBe(0);
    expect(saved.provenance.citations).toHaveLength(1);
    expect(saved.provenance.citations[0].ref).toBe('m1');
    // latencyMs is computed from startedAt — should be a finite, non-negative number.
    expect(typeof saved.provenance.latencyMs).toBe('number');
    expect(saved.provenance.latencyMs).toBeGreaterThanOrEqual(0);
    // startedAt is internal bookkeeping and must not leak into the saved row.
    expect(saved.provenance.startedAt).toBeUndefined();
    // Provenance map is cleaned up after persistence.
    expect(ctx.investigationProvenance.has('inv_p2')).toBe(false);
  });
});
