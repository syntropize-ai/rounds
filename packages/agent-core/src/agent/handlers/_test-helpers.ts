/**
 * Minimal test fixtures for handler unit tests.
 *
 * Builds a fake `ActionContext` with sensible no-op defaults; tests only
 * stub the pieces they actually exercise. Kept separate from the production
 * `test-helpers.ts` so handler tests don't have to import the whole
 * orchestrator-side `AccessControlStub`.
 */

import { vi, type Mock } from 'vitest';
import { AdapterRegistry } from '../../adapters/registry.js';
import { AccessControlStub, makeTestIdentity } from '../test-helpers.js';
import type { ActionContext } from './_context.js';

export interface FakeActionContext extends ActionContext {
  /** Spy capturing every SSE event the handler emits. */
  sendEvent: Mock;
  /** Spy capturing emitted agent events. */
  emitAgentEvent: Mock;
  /** Spy capturing pushed conversation actions. */
  pushConversationAction: Mock;
  /** Spy capturing navigate-to calls. */
  setNavigateTo: Mock;
}

/**
 * Build a fake `ActionContext` for handler tests. Pass `overrides` to swap
 * in real or fake stores / adapters / identity for the bits the test cares
 * about; everything else gets a thin spy or no-op default.
 */
export function makeFakeActionContext(
  overrides: Partial<ActionContext> = {},
): FakeActionContext {
  const sendEvent = vi.fn();
  const emitAgentEvent = vi.fn();
  const pushConversationAction = vi.fn();
  const setNavigateTo = vi.fn();

  const ctx = {
    gateway: {} as ActionContext['gateway'],
    model: 'test-model',
    store: {
      findById: vi.fn().mockResolvedValue(undefined),
      update: vi.fn(),
      updatePanels: vi.fn(),
      updateVariables: vi.fn(),
    } as unknown as ActionContext['store'],
    investigationReportStore: {
      save: vi.fn(),
    } as ActionContext['investigationReportStore'],
    alertRuleStore: {
      create: vi.fn(),
    } as unknown as ActionContext['alertRuleStore'],
    adapters: new AdapterRegistry(),
    sendEvent,
    sessionId: 'test-session',
    identity: makeTestIdentity(),
    accessControl: new AccessControlStub(),
    actionExecutor: {
      execute: vi.fn().mockResolvedValue(undefined),
    } as unknown as ActionContext['actionExecutor'],
    alertRuleAgent: {} as ActionContext['alertRuleAgent'],
    emitAgentEvent,
    makeAgentEvent: (type: string, metadata?: Record<string, unknown>) => ({
      type,
      agentType: 'orchestrator',
      timestamp: new Date().toISOString(),
      metadata,
    }) as ReturnType<ActionContext['makeAgentEvent']>,
    pushConversationAction,
    setNavigateTo,
    investigationSections: new Map(),
    investigationProvenance: new Map(),
    activeInvestigationId: null,
    activeDashboardId: null,
    freshlyCreatedDashboards: new Set<string>(),
    dashboardBuildEvidence: {
      webSearchCount: 0,
      metricDiscoveryCount: 0,
      validatedQueries: new Set<string>(),
    },
    ...overrides,
  } as FakeActionContext;

  return ctx;
}
