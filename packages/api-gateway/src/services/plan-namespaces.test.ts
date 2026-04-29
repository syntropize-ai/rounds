import { describe, it, expect } from 'vitest';
import type { RemediationPlan, RemediationPlanStep } from '@agentic-obs/data-layer';
import { extractPlanNamespaces } from './plan-namespaces.js';

function step(overrides: Partial<RemediationPlanStep>): RemediationPlanStep {
  return {
    id: 's',
    planId: 'p',
    ordinal: 0,
    kind: 'ops.run_command',
    commandText: '',
    paramsJson: { argv: [] },
    dryRunText: null,
    riskNote: null,
    continueOnError: false,
    status: 'pending',
    approvalRequestId: null,
    executedAt: null,
    outputText: null,
    errorText: null,
    ...overrides,
  };
}

function plan(steps: RemediationPlanStep[]): RemediationPlan {
  return {
    id: 'p1',
    orgId: 'org_main',
    investigationId: 'inv-1',
    rescueForPlanId: null,
    summary: '',
    status: 'pending_approval',
    autoEdit: false,
    approvalRequestId: null,
    createdBy: 'agent',
    createdAt: '',
    expiresAt: '',
    resolvedAt: null,
    resolvedBy: null,
    steps,
  };
}

describe('extractPlanNamespaces', () => {
  it('returns empty + cluster-scoped flag when steps have no -n flag', () => {
    const r = extractPlanNamespaces(plan([
      step({ paramsJson: { argv: ['get', 'nodes'] } }),
    ]));
    expect(r.namespaces).toEqual([]);
    expect(r.hasClusterScoped).toBe(true);
  });

  it('parses -n', () => {
    const r = extractPlanNamespaces(plan([
      step({ paramsJson: { argv: ['scale', 'deploy/web', '-n', 'app', '--replicas=3'] } }),
    ]));
    expect(r.namespaces).toEqual(['app']);
    expect(r.hasClusterScoped).toBe(false);
  });

  it('parses --namespace=', () => {
    const r = extractPlanNamespaces(plan([
      step({ paramsJson: { argv: ['get', 'pods', '--namespace=payments'] } }),
    ]));
    expect(r.namespaces).toEqual(['payments']);
  });

  it('dedupes + sorts across multiple steps', () => {
    const r = extractPlanNamespaces(plan([
      step({ ordinal: 0, paramsJson: { argv: ['scale', 'a', '-n', 'app'] } }),
      step({ ordinal: 1, paramsJson: { argv: ['scale', 'b', '-n', 'payments'] } }),
      step({ ordinal: 2, paramsJson: { argv: ['rollout', 'status', 'a', '-n', 'app'] } }),
    ]));
    expect(r.namespaces).toEqual(['app', 'payments']);
    expect(r.hasClusterScoped).toBe(false);
  });

  it('mixed cluster-scoped + namespaced flags both', () => {
    const r = extractPlanNamespaces(plan([
      step({ ordinal: 0, paramsJson: { argv: ['scale', 'a', '-n', 'app'] } }),
      step({ ordinal: 1, paramsJson: { argv: ['get', 'nodes'] } }),
    ]));
    expect(r.namespaces).toEqual(['app']);
    expect(r.hasClusterScoped).toBe(true);
  });

  it('treats malformed argv as cluster-scoped (defensive)', () => {
    const r = extractPlanNamespaces(plan([
      step({ paramsJson: { argv: 'not an array' as unknown as string[] } }),
    ]));
    expect(r.hasClusterScoped).toBe(true);
  });
});
