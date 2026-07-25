import { describe, expect, it, vi } from 'vitest';
import type { Investigation } from '@agentic-obs/common';

// Capture-fail T1.1 test asserts a structured warn log; intercept the logger
// factory so we don't have to scrape pino's stream output.
const warnSpy = vi.fn();
vi.mock('@agentic-obs/server-utils/logging', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agentic-obs/server-utils/logging')>();
  return {
    ...actual,
    createLogger: (name: string) => {
      const real = actual.createLogger(name);
      return new Proxy(real, {
        get(target, prop) {
          if (prop === 'warn') return warnSpy;
          return (target as unknown as Record<string | symbol, unknown>)[prop];
        },
      });
    },
  };
});

import {
  handleInvestigationAddSection,
  handleInvestigationComplete,
  handleInvestigationCreate,
  handleInvestigationRecordCheck,
} from './investigation.js';
import { makeFakeActionContext } from './_test-helpers.js';
import { AdapterRegistry } from '../../adapters/registry.js';
import type { IMetricsAdapter } from '../../adapters/metrics-adapter.js';
import type { FakeActionContext } from './_test-helpers.js';

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

function completionArgs(overrides: Record<string, unknown> = {}) {
  return {
    summary: 'Deployment/reviews-v2 is likely failing because its memory limit is too low.',
    rootCause: {
      status: 'likely',
      object: 'Deployment/reviews-v2',
      field: 'resources.limits.memory',
      cause: 'memory limit too low causing OOMKilled restarts',
    },
    confidence: 0.85,
    evidenceRefs: ['check_1', 'check_2'],
    ruledOut: ['no traffic'],
    nextAction: 'Raise the memory limit or roll back the deployment, then verify restarts and error rate return to baseline.',
    validationMethod: 'watch OOMKilled restarts for reviews-v2 drop to zero after the limit change',
    ...overrides,
  };
}

async function seedReadyLedger(ctx: FakeActionContext) {
  await handleInvestigationRecordCheck(ctx, {
    hypothesis: 'reviews-v2 is OOMKilled',
    signalType: 'kubernetes',
    tool: 'ops_run_command',
    query: 'kubectl describe pod reviews-v2',
    result: 'reviews-v2 last state terminated: OOMKilled during the last 30m in the affected service scope',
    interpretation: 'Supports a workload-level memory failure caused by a low memory limit.',
    status: 'supported',
    scope: { timeWindow: 'last 30m', affected: 'Deployment/reviews-v2 in namespace prod' },
    nextCheck: 'Check traffic is present.',
  });
  await handleInvestigationRecordCheck(ctx, {
    hypothesis: 'HTTP errors are caused by no traffic or scrape artifact',
    signalType: 'metric',
    tool: 'metrics_range_query',
    query: 'rate(istio_requests_total[5m])',
    result: 'traffic is present during the last 30m and 5xx appears only for reviews-v2',
    interpretation: 'Rules out no traffic and points at reviews-v2.',
    status: 'ruled_out',
    scope: { timeWindow: 'last 30m', affected: 'namespace prod' },
  });
}

describe('investigation handlers', () => {
  it('records diagnostic checks in the structured investigation ledger', async () => {
    const ctx = makeFakeActionContext({ activeInvestigationId: 'inv_1' });

    const result = await handleInvestigationRecordCheck(ctx, {
      hypothesis: 'reviews-v2 is OOMKilled',
      signalType: 'kubernetes',
      tool: 'ops_run_command',
      query: 'kubectl describe pod reviews-v2',
      result: 'last state terminated: OOMKilled',
      interpretation: 'Supports a workload memory failure.',
      status: 'supported',
      scope: { timeWindow: 'last 30m', affected: 'Deployment/reviews-v2' },
    });

    expect(result).toContain('Recorded check_1');
    expect(ctx.investigationStates.get('inv_1')?.checks).toHaveLength(1);
    expect(ctx.investigationStates.get('inv_1')?.hypotheses[0]?.status).toBe('supported');
  });

  it('rejects a check that records neither a time window nor an affected scope', async () => {
    const ctx = makeFakeActionContext({ activeInvestigationId: 'inv_1' });

    const result = await handleInvestigationRecordCheck(ctx, {
      hypothesis: 'reviews-v2 is OOMKilled',
      signalType: 'kubernetes',
      tool: 'ops_run_command',
      query: 'kubectl describe pod reviews-v2',
      result: 'last state terminated: OOMKilled',
      interpretation: 'Supports a workload memory failure.',
      status: 'supported',
      scope: { timeWindow: '  ' },
    });

    expect(result).toContain('Error: "scope"');
    expect(ctx.investigationStates.get('inv_1')).toBeUndefined();
  });

  it('does not save or navigate when completing without an active investigation', async () => {
    const store = investigationStore();
    const reportStore = { save: vi.fn() };
    const ctx = makeFakeActionContext({
      investigationStore: store,
      investigationReportStore: reportStore,
    });
    // ctx.activeInvestigationId defaults to null

    const result = await handleInvestigationComplete(ctx, completionArgs());

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

    await seedReadyLedger(ctx);

    const result = await handleInvestigationComplete(ctx, completionArgs());

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

    await seedReadyLedger(ctx);

    const result = await handleInvestigationComplete(ctx, completionArgs());

    expect(result).toContain('report saved');
    expect(reportStore.save).toHaveBeenCalledOnce();
    expect(store.updateStatus).toHaveBeenCalledWith('inv_1', 'completed');
    expect(ctx.setNavigateTo).toHaveBeenCalledWith('/investigations/inv_1');
    expect(ctx.sendEvent).toHaveBeenCalledWith({ type: 'navigate', path: '/investigations/inv_1' });
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

  it('investigation_create sets a draft activeInvestigationId without persisting yet', async () => {
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

    expect(store.create).not.toHaveBeenCalled();
    expect(ctx.activeInvestigationId).toMatch(/^draft_investigation_/);
    expect(ctx.pendingInvestigationCreates.get(ctx.activeInvestigationId!)).toEqual({ question: 'why is X slow?' });
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

    const draftId = ctx.activeInvestigationId!;
    const prov = ctx.investigationProvenance.get(draftId);
    expect(prov).toBeDefined();
    expect(prov!.runId).toBe(draftId);
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

    const after = ctx.investigationProvenance.get(draftId)!;
    expect(after.toolCalls).toBe(2);
    expect(after.evidenceCount).toBe(1);
    // Citations dedup by ref — m1 referenced twice → counted once.
    expect(after.citations?.map((c) => c.ref).sort()).toEqual(['l1', 'm1']);
    expect(after.citations?.find((c) => c.ref === 'm1')?.kind).toBe('metric');
    expect(after.citations?.find((c) => c.ref === 'l1')?.kind).toBe('log');
  });

  // ── T1.1 regression: snapshot capture failure is observable ─────────────
  it('warns + stamps captureError when snapshot capture fails, investigation still completes', async () => {
    const created = {
      id: 'inv_cap',
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

    // Throwing adapter — exercises the snapshot catch block.
    const failingAdapter: IMetricsAdapter = {
      instantQuery: vi.fn(async () => { throw new Error('prom unreachable'); }),
      rangeQuery: vi.fn(async () => { throw new Error('prom unreachable'); }),
    } as unknown as IMetricsAdapter;
    const adapters = new AdapterRegistry();
    adapters.register({
      info: { id: 'prom-1', name: 'prom-1', type: 'prometheus', signalType: 'metrics', isDefault: true },
      metrics: failingAdapter,
    });

    const ctx = makeFakeActionContext({
      investigationStore: store,
      investigationReportStore: reportStore,
      adapters,
    });

    await handleInvestigationCreate(ctx, { question: 'why' });
    const draftId = ctx.activeInvestigationId!;

    warnSpy.mockClear();
    await handleInvestigationAddSection(ctx, {
      type: 'evidence',
      content: 'CPU saturation',
      panel: {
        title: 'CPU',
        visualization: 'time_series',
        queries: [{ refId: 'A', expr: 'rate(cpu[5m])' }],
      },
    });

    // Section persisted with a captureError provenance marker.
    const sections = ctx.investigationSections.get(draftId)!;
    expect(sections).toHaveLength(1);
    const panel = sections[0]!.panel!;
    expect(panel.snapshotData?.captureError).toMatch(/prom unreachable/);

    // Warn log emitted with the structured context fields.
    const snapshotWarn = warnSpy.mock.calls.find(
      (c) => c[1] === 'investigation snapshot capture failed',
    );
    expect(snapshotWarn).toBeDefined();
    const ctxFields = snapshotWarn![0] as Record<string, unknown>;
    expect(ctxFields.investigationId).toBe(draftId);
    expect(ctxFields.queryKind).toBe('range');
    expect(ctxFields.adapterId).toBe('prom-1');
    expect(ctxFields.panelTitle).toBe('CPU');
    expect(ctxFields.errorClass).toBe('Error');

    // Investigation still completes — capture failure is non-fatal.
    await seedReadyLedger(ctx);
    const finishResult = await handleInvestigationComplete(ctx, completionArgs());
    expect(finishResult).toContain('report saved');
    expect(reportStore.save).toHaveBeenCalledOnce();
  });

  // ── T1.2 regression: final status-update failure is observable ──────────
  it('warns when updateStatus rejects at completion but still saves the report', async () => {
    const inv: Investigation = {
      id: 'inv_st',
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
      create: vi.fn(),
      findById: vi.fn(async () => inv),
      findAll: vi.fn(),
      updateStatus: vi.fn().mockRejectedValue(new Error('db unreachable')),
      updatePlan: vi.fn(),
      updateResult: vi.fn(),
    };
    const reportStore = { save: vi.fn() };
    const ctx = makeFakeActionContext({
      investigationStore: store,
      investigationReportStore: reportStore,
      activeInvestigationId: 'inv_st',
    });

    warnSpy.mockClear();
    await seedReadyLedger(ctx);
    const result = await handleInvestigationComplete(ctx, completionArgs());

    // Report saved regardless of status-update outcome.
    expect(result).toContain('report saved');
    expect(reportStore.save).toHaveBeenCalledOnce();

    // Warn emitted with structured context.
    const statusWarn = warnSpy.mock.calls.find(
      (c) => typeof c[1] === 'string' && c[1].includes('investigation updateStatus failed'),
    );
    expect(statusWarn).toBeDefined();
    const ctxFields = statusWarn![0] as Record<string, unknown>;
    expect(ctxFields.investigationId).toBe('inv_st');
    expect(ctxFields.targetStatus).toBe('completed');
    expect(ctxFields.error).toMatch(/db unreachable/);
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
    await seedReadyLedger(ctx);
    await handleInvestigationComplete(ctx, completionArgs({ summary: 'CPU saturation' }));

    expect(reportStore.save).toHaveBeenCalledOnce();
    const saved = (reportStore.save.mock.calls[0] ?? [])[0];
    expect(saved.provenance).toBeDefined();
    expect(saved.provenance.runId).toBe('inv_p2');
    expect(saved.provenance.toolCalls).toBe(1);
    expect(saved.provenance.evidenceCount).toBe(3);
    expect(saved.provenance.citations.map((c: { ref: string }) => c.ref).sort()).toEqual(['k1', 'm1', 'm2']);
    expect(saved.sections.some((s: { content: string }) => s.content.includes('## Evidence Trail'))).toBe(true);
    expect(saved.sections.some((s: { content: string }) => s.content.includes('## Conclusion'))).toBe(true);
    // latencyMs is computed from startedAt — should be a finite, non-negative number.
    expect(typeof saved.provenance.latencyMs).toBe('number');
    expect(saved.provenance.latencyMs).toBeGreaterThanOrEqual(0);
    // startedAt is internal bookkeeping and must not leak into the saved row.
    expect(saved.provenance.startedAt).toBeUndefined();
    // Provenance map is cleaned up after persistence.
    expect(ctx.investigationProvenance.has('inv_p2')).toBe(false);
  });

  describe('investigation completion', () => {
    it('saves without running a second readiness pass', async () => {
      const store = investigationStore();
      const reportStore = { save: vi.fn() };
      const ctx = makeFakeActionContext({
        investigationStore: store,
        investigationReportStore: reportStore,
        activeInvestigationId: 'inv_1',
      });
      ctx.investigationSections.set('inv_1', [
        { type: 'evidence', content: 'HTTP error rate is non-zero.' },
      ]);
      await seedReadyLedger(ctx);

      const result = await handleInvestigationComplete(ctx, completionArgs());

      expect(result).toContain('report saved');
      expect(reportStore.save).toHaveBeenCalledOnce();
      expect(ctx.activeInvestigationId).toBeNull();
    });

    it('allows honest unresolved completion with a concrete next check', async () => {
      const store = investigationStore();
      const reportStore = { save: vi.fn() };
      const ctx = makeFakeActionContext({
        investigationStore: store,
        investigationReportStore: reportStore,
        activeInvestigationId: 'inv_1',
      });
      await seedReadyLedger(ctx);
      ctx.investigationSections.set('inv_1', [
        { type: 'evidence', content: 'Error rate is elevated.' },
        { type: 'text', content: '## Specific object\n\nThe candidate cause is an EnvoyFilter config change.' },
      ]);

      const result = await handleInvestigationComplete(ctx, completionArgs({
        rootCause: {
          status: 'unresolved',
          nextCheck: 'Inspect EnvoyFilter diffs from the last rollout.',
        },
        confidence: 0.45,
        evidenceRefs: ['check_1', 'check_2'],
        ruledOut: ['no traffic'],
      }));

      expect(result).toContain('report saved');
      expect(reportStore.save).toHaveBeenCalledOnce();
      const saved = (reportStore.save.mock.calls[0] ?? [])[0];
      const unresolved = saved.sections.find((s: { content: string }) => s.content.startsWith('## Unresolved'));
      expect(unresolved?.content).toContain('Inspect EnvoyFilter diffs');
    });

    it('reuses the prior report id (update-in-place) when reopened', async () => {
      const store = investigationStore();
      const reportStore = { save: vi.fn() };
      const ctx = makeFakeActionContext({
        investigationStore: store,
        investigationReportStore: reportStore,
        activeInvestigationId: 'inv_1',
      });
      // Reopen seeds provenance with the existing report's id.
      ctx.investigationProvenance.set('inv_1', { runId: 'inv_1', reportId: 'report_existing' } as never);
      await seedReadyLedger(ctx);

      await handleInvestigationComplete(ctx, completionArgs({ summary: 'refined' }));

      const saved = (reportStore.save.mock.calls[0] ?? [])[0];
      expect(saved.id).toBe('report_existing');
      // reportId is bookkeeping — it must not leak into the saved provenance row.
      expect(saved.provenance?.reportId).toBeUndefined();
    });

    it('saves normally when the ledger supports an 80 percent likely root cause', async () => {
      const store = investigationStore();
      const reportStore = { save: vi.fn() };
      const ctx = makeFakeActionContext({
        investigationStore: store,
        investigationReportStore: reportStore,
        activeInvestigationId: 'inv_1',
      });
      await seedReadyLedger(ctx);
      ctx.investigationSections.set('inv_1', [
        { type: 'evidence', content: 'Error rate is elevated.' },
        { type: 'text', content: '## Specific object\n\nThe cause is a deployment config value.' },
      ]);

      const result = await handleInvestigationComplete(ctx, completionArgs());

      expect(result).toContain('report saved');
      expect(reportStore.save).toHaveBeenCalledOnce();
      const saved = (reportStore.save.mock.calls[0] ?? [])[0];
      expect(saved.provenance?.rootCauseGate?.status).toBe('passed');
      expect(ctx.activeInvestigationId).toBeNull();
    });

    it('downgrades a claimed root cause to unresolved when evidence gate fails', async () => {
      const store = investigationStore();
      const reportStore = { save: vi.fn() };
      const ctx = makeFakeActionContext({
        investigationStore: store,
        investigationReportStore: reportStore,
        activeInvestigationId: 'inv_1',
      });

      await handleInvestigationRecordCheck(ctx, {
        hypothesis: 'error rate is elevated',
        signalType: 'metric',
        tool: 'metrics_query',
        query: 'error_rate',
        result: 'error rate is 12%',
        interpretation: 'Confirms the symptom but not the cause.',
        status: 'supported',
        scope: { timeWindow: 'last 30m' },
      });

      const result = await handleInvestigationComplete(ctx, completionArgs({
        evidenceRefs: ['check_1'],
        ruledOut: [],
        nextAction: 'Raise the memory limit.',
        validationMethod: undefined,
      }));

      expect(result).toContain('saved as unresolved');
      expect(reportStore.save).toHaveBeenCalledOnce();
      const saved = (reportStore.save.mock.calls[0] ?? [])[0];
      expect(saved.provenance?.rootCauseGate?.status).toBe('unresolved');
      expect(saved.provenance?.rootCauseGate?.reasons).toEqual(
        expect.arrayContaining([
          expect.stringContaining('competing explanations'),
          expect.stringContaining('validate'),
        ]),
      );
      expect(saved.sections.some((s: { content: string }) => s.content.includes('## Unresolved'))).toBe(true);
    });
  });
});
