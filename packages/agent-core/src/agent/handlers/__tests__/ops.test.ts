import { describe, expect, it, vi } from 'vitest';
import { AdapterRegistry } from '../../../adapters/index.js';
import { handleOpsRunCommand } from '../ops.js';
import type { ActionContext } from '../_context.js';

function makeCtx(overrides: Partial<ActionContext> = {}): ActionContext {
  return {
    gateway: {} as ActionContext['gateway'],
    model: 'test',
    store: {} as ActionContext['store'],
    investigationReportStore: {} as ActionContext['investigationReportStore'],
    alertRuleStore: {} as ActionContext['alertRuleStore'],
    adapters: new AdapterRegistry(),
    sendEvent: vi.fn(),
    sessionId: 'session-1',
    identity: { userId: 'u1', orgId: 'org1', orgRole: 'Admin', isServerAdmin: false, authenticatedBy: 'session' },
    accessControl: {
      evaluate: async () => true,
      filterByPermission: async (_id, rows) => rows,
    },
    actionExecutor: {} as ActionContext['actionExecutor'],
    alertRuleAgent: {} as ActionContext['alertRuleAgent'],
    emitAgentEvent: vi.fn(),
    makeAgentEvent: ((type: string) => ({ type, agentType: 'orchestrator', timestamp: '' })) as ActionContext['makeAgentEvent'],
    pushConversationAction: vi.fn(),
    setNavigateTo: vi.fn(),
    investigationSections: new Map(),
    activeInvestigationId: null,
    activeDashboardId: null,
    ...overrides,
  } as ActionContext;
}

describe('handleOpsRunCommand', () => {
  it('returns a clear not-configured observation when no runner is wired', async () => {
    const ctx = makeCtx();
    const result = await handleOpsRunCommand(ctx, {
      connectorId: 'kube-prod',
      command: 'kubectl get pods',
      intent: 'read',
    });

    expect(result).toContain('Ops command runner is not configured');
  });

  it('does not call the runner when no connectors are configured', async () => {
    const runCommand = vi.fn();
    const ctx = makeCtx({
      opsCommandRunner: {
        listConnectors: async () => [],
        runCommand,
      },
    });

    const result = await handleOpsRunCommand(ctx, {
      connectorId: 'kube-prod',
      command: 'kubectl get pods',
      intent: 'read',
    });

    expect(result).toContain('No Ops connectors are configured');
    expect(runCommand).not.toHaveBeenCalled();
  });

  it('passes connectorId, command, intent, identity, and sessionId to the runner', async () => {
    const runCommand = vi.fn(async () => ({ observation: 'pods listed' }));
    const ctx = makeCtx({
      opsConnectors: [{ id: 'kube-prod', name: 'Production' }],
      opsCommandRunner: { runCommand },
    });

    const result = await handleOpsRunCommand(ctx, {
      connectorId: 'kube-prod',
      command: 'kubectl get pods -n api',
      intent: 'read',
    });

    expect(result).toBe('pods listed');
    expect(runCommand).toHaveBeenCalledWith({
      connectorId: 'kube-prod',
      command: 'kubectl get pods -n api',
      intent: 'read',
      identity: ctx.identity,
      sessionId: 'session-1',
    });
  });
});
