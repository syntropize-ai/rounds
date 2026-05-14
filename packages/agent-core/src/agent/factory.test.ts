/**
 * Factory tests — focus on the audit-writer bridge (T1.5 / Wave-1 leftover).
 *
 * The factory's job is "construct the agent runner and wire deps". The
 * one piece of behavior here that isn't already covered by orchestrator
 * tests is the new bridge: when the api-gateway hands the factory an
 * `AuditWriter` (with `.log(entry)`), every handler's
 * `ctx.auditWriter?.(entry)` must reach that writer.
 *
 * We don't drive a full ReAct loop here — that requires a real LLM
 * gateway. We construct the action context the same way the orchestrator
 * does and call a handler directly, asserting the audit row lands.
 */

import { describe, it, expect, vi } from 'vitest';
import { AuditAction } from '@agentic-obs/common';
import type { Identity, NewAuditLogEntry } from '@agentic-obs/common';
import { AdapterRegistry } from '../adapters/index.js';
import { ActionExecutor } from './action-executor.js';
import { buildActionContext } from './orchestrator-action-context.js';
import { createAgentRunner } from './factory.js';
import { handleDashboardCreate } from './handlers/dashboard.js';
import type { IAuditWriter } from './types-permissions.js';

function makeIdentity(): Identity {
  return {
    userId: 'u1',
    orgId: 'org1',
    orgRole: 'Admin',
    isServerAdmin: false,
    authenticatedBy: 'session',
  };
}

function makeFakeAuditWriter() {
  const entries: unknown[] = [];
  const writer: IAuditWriter = {
    log: vi.fn(async (entry) => {
      entries.push(entry);
    }),
  };
  return { writer, entries };
}

describe('createAgentRunner', () => {
  it('returns a runner with a sessionId', () => {
    const { writer } = makeFakeAuditWriter();
    const runner = createAgentRunner(makeRunnerDeps({ auditWriter: writer }));
    expect(typeof runner.sessionId).toBe('string');
    expect(runner.sessionId.length).toBeGreaterThan(0);
  });

  it('preserves an explicit sessionId', () => {
    const { writer } = makeFakeAuditWriter();
    const runner = createAgentRunner(
      makeRunnerDeps({ auditWriter: writer }),
      'session-fixed',
    );
    expect(runner.sessionId).toBe('session-fixed');
  });
});

describe('audit-writer bridge', () => {
  it('bridges IAuditWriter.log into ActionContext.auditWriter', async () => {
    const { writer, entries } = makeFakeAuditWriter();

    // Build context the same way the factory-built runner does: route the
    // structured writer through the bridge.
    const ctx = buildActionContext(
      makeContextDeps({
        auditEntryWriter: (entry) => writer.log(entry),
      }),
      makeContextRuntime(),
    );

    expect(ctx.auditWriter).toBeDefined();

    // Invoke the dashboard.create handler and assert the audit row reached
    // the underlying AuditWriter.
    const result = await handleDashboardCreate(ctx, {
      title: 'Latency overview',
      datasourceId: 'ds-prod',
    });

    expect(result).toContain('Created dashboard');
    // The handler fires-and-forgets; give the microtask queue a tick.
    await new Promise((r) => setTimeout(r, 0));

    expect(writer.log).toHaveBeenCalled();
    expect(entries).toHaveLength(1);
    const entry = entries[0] as { action: string; targetType: string };
    expect(entry.action).toBe(AuditAction.DashboardCreate);
    expect(entry.targetType).toBe('dashboard');
  });

  it('leaves ActionContext.auditWriter undefined when no writer is wired', () => {
    const ctx = buildActionContext(makeContextDeps({}), makeContextRuntime());
    expect(ctx.auditWriter).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

function makeContextDeps(overrides: {
  auditEntryWriter?: (entry: NewAuditLogEntry) => Promise<void>;
}): Parameters<typeof buildActionContext>[0] {
  const created: Record<string, unknown> = {
    id: 'dash-1',
    title: 'Latency overview',
    workspaceId: 'org1',
  };
  return {
    gateway: {} as never,
    model: 'test-model',
    store: {
      create: vi.fn(async (input: Record<string, unknown>) => ({
        ...input,
        ...created,
      })),
    } as never,
    conversationStore: {} as never,
    investigationReportStore: {} as never,
    alertRuleStore: {} as never,
    adapters: new AdapterRegistry(),
    sendEvent: () => undefined,
    identity: makeIdentity(),
    accessControl: {
      filterByPermission: async (list: unknown[]) => list,
      checkPermission: async () => ({ ok: true }),
    } as never,
    ...(overrides.auditEntryWriter
      ? { auditEntryWriter: overrides.auditEntryWriter as never }
      : {}),
  };
}

function makeContextRuntime(): Parameters<typeof buildActionContext>[1] {
  return {
    sessionId: 'sess-1',
    actionExecutor: new ActionExecutor({} as never, () => undefined),
    emitAgentEvent: () => undefined,
    makeAgentEvent: (type) => ({ type, agentType: 'orchestrator', timestamp: 'now' }) as never,
    pushConversationAction: () => undefined,
    setNavigateTo: () => undefined,
    investigationSections: new Map(),
    investigationProvenance: new Map(),
    activeInvestigationIdRef: { current: null },
    activeDashboardIdRef: { current: null },
    freshlyCreatedDashboards: new Set<string>(),
    dashboardBuildEvidence: {
      webSearchCount: 0,
      metricDiscoveryCount: 0,
      validatedQueries: new Set<string>(),
    },
  };
}

function makeRunnerDeps(overrides: {
  auditWriter?: IAuditWriter;
}): Parameters<typeof createAgentRunner>[0] {
  return {
    gateway: {} as never,
    model: 'test-model',
    store: {} as never,
    conversationStore: {
      getMessages: async () => [],
      addMessage: async (_k: string, m: unknown) => m as never,
      clearMessages: async () => undefined,
      deleteConversation: async () => undefined,
    } as never,
    investigationReportStore: {} as never,
    alertRuleStore: {} as never,
    adapters: new AdapterRegistry(),
    sendEvent: () => undefined,
    identity: makeIdentity(),
    accessControl: {
      filterByPermission: async (list: unknown[]) => list,
      checkPermission: async () => ({ ok: true }),
    } as never,
    ...(overrides.auditWriter ? { auditWriter: overrides.auditWriter } : {}),
  };
}
