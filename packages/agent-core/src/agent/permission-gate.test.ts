import { describe, it, expect } from 'vitest';
import { checkPermission, denialObservation } from './permission-gate.js';
import type { AgentDefinition } from './agent-definition.js';
import type { ActionContext } from './orchestrator-action-handlers.js';
import { AccessControlStub, makeTestIdentity } from './test-helpers.js';
import { AdapterRegistry } from '../adapters/index.js';

function makeCtx(allowAll = true): ActionContext {
  return {
    gateway: {} as ActionContext['gateway'],
    model: 'test',
    store: {} as ActionContext['store'],
    investigationReportStore: {} as ActionContext['investigationReportStore'],
    alertRuleStore: {} as ActionContext['alertRuleStore'],
    adapters: new AdapterRegistry(),
    allDatasources: [{ id: 'ds-prom', type: 'prometheus', name: 'Prom', url: 'http://x', isDefault: true }],
    sendEvent: () => {},
    sessionId: 's',
    identity: makeTestIdentity(),
    accessControl: new AccessControlStub(() => allowAll),
    actionExecutor: {} as ActionContext['actionExecutor'],
    alertRuleAgent: {} as ActionContext['alertRuleAgent'],
    emitAgentEvent: () => {},
    makeAgentEvent: ((type: string) => ({ type, agentType: 'orchestrator', timestamp: '' })) as ActionContext['makeAgentEvent'],
    pushConversationAction: () => {},
    setNavigateTo: () => {},
    investigationSections: new Map(),
    investigationProvenance: new Map(),
    freshlyCreatedDashboards: new Set<string>(),
    dashboardBuildEvidence: {
      webSearchCount: 0,
      metricDiscoveryCount: 0,
      validatedQueries: new Set<string>(),
    },
    activeInvestigationId: null,
    activeDashboardId: null,
  } as ActionContext;
}

const writeAgent: AgentDefinition = {
  type: 'orchestrator',
  description: 'test orchestrator',
  allowedTools: ['dashboard_create', 'dashboard_list', 'metrics_query'],
  inputKinds: ['dashboard'],
  outputKinds: [],
  permissionMode: 'artifact_mutation',
};

// Layer-2 test fixture. `type` just needs to be a valid AgentType — the
// real Layer-2 enforcement keys on permissionMode, not the name.
const readOnlyAgent: AgentDefinition = {
  ...writeAgent,
  type: 'orchestrator',
  permissionMode: 'read_only',
};

const proposeOnlyAgent: AgentDefinition = {
  ...writeAgent,
  type: 'alert-rule-builder',
  permissionMode: 'propose_only',
};

describe('checkPermission — three-layer evaluation', () => {
  it('Layer 1: tool not in allowedTools → deny with reason=allowedTools', async () => {
    const out = await checkPermission(writeAgent, 'dashboard_modify_panel', {}, makeCtx());
    expect(out.ok).toBe(false);
    expect(out.reason).toBe('allowedTools');
    expect(out.action).toBe('dashboard_modify_panel');
  });

  it('Layer 2: read_only agent + mutation → deny with reason=permissionMode', async () => {
    const out = await checkPermission(readOnlyAgent, 'dashboard_create', {}, makeCtx());
    expect(out.ok).toBe(false);
    expect(out.reason).toBe('permissionMode');
    expect(out.scope).toBe('mode:read_only');
  });

  it('Layer 2: read_only agent + list tool → allowed (reads pass Layer 2)', async () => {
    const out = await checkPermission(readOnlyAgent, 'dashboard_list', {}, makeCtx());
    expect(out.ok).toBe(true);
  });

  it('Layer 2: propose_only agent + mutation → deny with reason=permissionMode', async () => {
    const out = await checkPermission(proposeOnlyAgent, 'dashboard_create', {}, makeCtx());
    expect(out.ok).toBe(false);
    expect(out.reason).toBe('permissionMode');
    expect(out.scope).toBe('mode:propose_only');
  });

  it('Layer 3: RBAC denies → reason=rbac, action/scope populated', async () => {
    const out = await checkPermission(
      writeAgent,
      'dashboard_create',
      { folderUid: 'prod' },
      makeCtx(/* allowAll */ false),
    );
    expect(out.ok).toBe(false);
    expect(out.reason).toBe('rbac');
    expect(out.action).toBe('dashboards:create');
    expect(out.scope).toBe('folders:uid:prod');
  });

  it('Layer 1 wins over Layer 3 — allowedTools short-circuit', async () => {
    // propose_only agent AND tool not in list AND allowAll true — Layer 1 fires first.
    const out = await checkPermission(
      { ...writeAgent, allowedTools: [] },
      'dashboard_create',
      {},
      makeCtx(true),
    );
    expect(out.reason).toBe('allowedTools');
  });

  it('Layer 2 wins over Layer 3 when both would deny', async () => {
    const out = await checkPermission(readOnlyAgent, 'dashboard_create', {}, makeCtx(false));
    expect(out.reason).toBe('permissionMode');
  });

  it('all three layers pass → ok:true', async () => {
    const out = await checkPermission(writeAgent, 'dashboard_create', { folderUid: 'prod' }, makeCtx(true));
    expect(out.ok).toBe(true);
  });

  it('terminal action ask_user is always allowed (never reaches the gate in practice)', async () => {
    expect((await checkPermission(writeAgent, 'ask_user', {}, makeCtx(false))).ok).toBe(true);
  });
});

describe('denialObservation', () => {
  it('renders the `permission denied:` prefix verbatim', () => {
    expect(
      denialObservation({ ok: false, reason: 'rbac', action: 'dashboards:create', scope: 'folders:uid:prod' }),
    ).toBe('permission denied: dashboards:create on folders:uid:prod');
  });

  it('falls back to sensible defaults when fields are missing', () => {
    expect(denialObservation({ ok: false, reason: 'rbac' })).toBe(
      'permission denied: unknown on *',
    );
  });
});
