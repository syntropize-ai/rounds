/**
 * Tests for `ops.run_command` parsing helpers and the handler boundary. The
 * runner owns kubectl policy; the handler only validates connector selection.
 */

import { describe, it, expect, vi } from 'vitest';
import { AdapterRegistry } from '../../../adapters/index.js';
import { handleOpsRunCommand } from '../ops.js';
import { parseKubectlCommandString } from '@agentic-obs/adapters';
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
    identity: { userId: 'u1', orgId: 'org_main', orgRole: 'Admin', isServerAdmin: false, authenticatedBy: 'session' },
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

describe('parseKubectlCommandString', () => {
  it('drops the leading kubectl token', () => {
    expect(parseKubectlCommandString('kubectl get pods -n app')).toEqual(['get', 'pods', '-n', 'app']);
  });
  it('returns empty for shell-meta containing inputs', () => {
    expect(parseKubectlCommandString('kubectl get pods | grep web')).toEqual([]);
    expect(parseKubectlCommandString('kubectl get pods $(echo x)')).toEqual([]);
    expect(parseKubectlCommandString('kubectl get pods; rm -rf /')).toEqual([]);
  });
  it('handles double-quoted args', () => {
    expect(parseKubectlCommandString('kubectl annotate pod web "kubernetes.io/x=y" -n app')).toEqual([
      'annotate', 'pod', 'web', 'kubernetes.io/x=y', '-n', 'app',
    ]);
  });
  it('returns empty on unterminated quotes', () => {
    expect(parseKubectlCommandString('kubectl get pods "unterminated')).toEqual([]);
  });
});

describe('handleOpsRunCommand runner boundary', () => {
  function mkRunner(): ActionContext['opsCommandRunner'] {
    return {
      runCommand: vi.fn().mockResolvedValue({ observation: 'ran', decision: 'executed' }),
      listConnectors: vi.fn().mockResolvedValue(undefined),
    } as unknown as ActionContext['opsCommandRunner'];
  }

  it('forwards intent=read write-shaped commands to the runner policy', async () => {
    const runner = mkRunner();
    const ctx = makeCtx({
      opsCommandRunner: runner,
      opsConnectors: [{ id: 'k8s-prod', name: 'k8s-prod', namespaces: ['app'], capabilities: [] }],
    });
    const r = await handleOpsRunCommand(ctx, {
      connectorId: 'k8s-prod',
      command: 'kubectl scale deploy/web -n app --replicas=3',
      intent: 'read',
    });
    expect(r).toBe('ran');
    expect((runner as unknown as { runCommand: ReturnType<typeof vi.fn> }).runCommand).toHaveBeenCalledWith(
      expect.objectContaining({ connectorId: 'k8s-prod', command: 'kubectl scale deploy/web -n app --replicas=3', intent: 'read' }),
    );
  });

  it('forwards denied command shapes to the runner policy', async () => {
    const runner = mkRunner();
    const ctx = makeCtx({
      opsCommandRunner: runner,
      opsConnectors: [{ id: 'k8s-prod', name: 'k8s-prod', namespaces: ['app'], capabilities: [] }],
    });
    const r = await handleOpsRunCommand(ctx, {
      connectorId: 'k8s-prod',
      command: 'kubectl exec web -n app -- sh',
      intent: 'read',
    });
    expect(r).toBe('ran');
    expect((runner as unknown as { runCommand: ReturnType<typeof vi.fn> }).runCommand).toHaveBeenCalledTimes(1);
  });

  it('forwards namespace policy decisions to the runner policy', async () => {
    const runner = mkRunner();
    const ctx = makeCtx({
      opsCommandRunner: runner,
      opsConnectors: [{ id: 'k8s-prod', name: 'k8s-prod', namespaces: ['app'], capabilities: [] }],
    });
    const r = await handleOpsRunCommand(ctx, {
      connectorId: 'k8s-prod',
      command: 'kubectl get pods -n kube-system',
      intent: 'read',
    });
    expect(r).toBe('ran');
    expect((runner as unknown as { runCommand: ReturnType<typeof vi.fn> }).runCommand).toHaveBeenCalledTimes(1);
  });

  it('passes through intent=read for kubectl get on an allowlisted namespace', async () => {
    const runner = mkRunner();
    const ctx = makeCtx({
      opsCommandRunner: runner,
      opsConnectors: [{ id: 'k8s-prod', name: 'k8s-prod', namespaces: ['app'], capabilities: [] }],
    });
    const r = await handleOpsRunCommand(ctx, {
      connectorId: 'k8s-prod',
      command: 'kubectl get pods -n app',
      intent: 'read',
    });
    expect(r).toBe('ran');
    expect((runner as unknown as { runCommand: ReturnType<typeof vi.fn> }).runCommand).toHaveBeenCalledTimes(1);
  });

  it('does not gate intent=propose; the runner / approval flow handles writes', async () => {
    const runner = mkRunner();
    const ctx = makeCtx({
      opsCommandRunner: runner,
      opsConnectors: [{ id: 'k8s-prod', name: 'k8s-prod', namespaces: ['app'], capabilities: [] }],
    });
    const r = await handleOpsRunCommand(ctx, {
      connectorId: 'k8s-prod',
      command: 'kubectl scale deploy/web -n app --replicas=3',
      intent: 'propose',
    });
    expect(r).toBe('ran');
    expect((runner as unknown as { runCommand: ReturnType<typeof vi.fn> }).runCommand).toHaveBeenCalledTimes(1);
  });

  it('forwards unparseable command strings to the runner policy', async () => {
    const runner = mkRunner();
    const ctx = makeCtx({
      opsCommandRunner: runner,
      opsConnectors: [{ id: 'k8s-prod', name: 'k8s-prod', namespaces: ['app'], capabilities: [] }],
    });
    const r = await handleOpsRunCommand(ctx, {
      connectorId: 'k8s-prod',
      command: 'kubectl get pods | grep web',
      intent: 'read',
    });
    // we don't gate when parse fails — runner is reached
    expect(r).toBe('ran');
  });
});
