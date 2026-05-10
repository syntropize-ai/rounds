import { describe, expect, it, vi } from 'vitest';
import type { ProposedAction } from '@agentic-obs/common';
import { ActionGuard, pickConfirmationMode } from '../action-guard.js';

const validateScaleParams = (action: ProposedAction): string | null => {
  if (action.capability !== 'runtime.scale') return null;
  if (typeof action.params['replicas'] !== 'number') return 'replicas must be number';
  if ((action.params['replicas'] as number) < 0) return 'replicas must be >= 0';
  return null;
};

function makeAction(overrides: Partial<ProposedAction> = {}): ProposedAction {
  return {
    actorUserId: 'u1',
    orgId: 'org1',
    connectorId: 'k8s-prod',
    capability: 'runtime.scale',
    verb: 'scale',
    resource: { kind: 'Deployment', name: 'web', namespace: 'app' },
    params: { replicas: 3 },
    risk: 'high',
    source: 'user_conversation',
    ...overrides,
  };
}

describe('ActionGuard.decide', () => {
  it('user_conversation high risk with permission → allow + strong_user_confirm', async () => {
    const audit = vi.fn().mockResolvedValue('audit-1');
    const guard = new ActionGuard({
      permissionChecker: () => true,
      auditWriter: audit,
      validateParams: validateScaleParams,
    });
    const decision = await guard.decide(makeAction());
    expect(decision.kind).toBe('allow');
    if (decision.kind !== 'allow') return;
    expect(decision.confirmationMode).toBe('strong_user_confirm');
    expect(decision.confirmationMode).not.toBe('formal_approval');
    expect(audit).toHaveBeenCalledTimes(1);
    expect(audit.mock.calls[0]![0]).toMatchObject({
      decision: 'allow',
      confirmationMode: 'strong_user_confirm',
      source: 'user_conversation',
    });
  });

  it('background_agent high risk → allow + formal_approval', async () => {
    const audit = vi.fn();
    const guard = new ActionGuard({
      permissionChecker: () => true,
      auditWriter: audit,
      validateParams: validateScaleParams,
    });
    const decision = await guard.decide(
      makeAction({ source: 'background_agent', actorUserId: undefined, risk: 'high' }),
    );
    expect(decision.kind).toBe('allow');
    if (decision.kind !== 'allow') return;
    expect(decision.confirmationMode).toBe('formal_approval');
  });

  it('background_agent critical risk → allow + formal_approval', async () => {
    const guard = new ActionGuard({
      permissionChecker: () => true,
      validateParams: validateScaleParams,
    });
    const decision = await guard.decide(
      makeAction({ source: 'background_agent', risk: 'critical' }),
    );
    expect(decision.kind).toBe('allow');
    if (decision.kind !== 'allow') return;
    expect(decision.confirmationMode).toBe('formal_approval');
  });

  it('background_agent low risk → allow + none', async () => {
    const guard = new ActionGuard({
      permissionChecker: () => true,
      validateParams: validateScaleParams,
    });
    const decision = await guard.decide(
      makeAction({ source: 'background_agent', risk: 'low' }),
    );
    expect(decision.kind).toBe('allow');
    if (decision.kind !== 'allow') return;
    expect(decision.confirmationMode).toBe('none');
  });

  it('user_conversation medium risk → user_confirm', async () => {
    const guard = new ActionGuard({
      permissionChecker: () => true,
      validateParams: validateScaleParams,
    });
    const decision = await guard.decide(makeAction({ risk: 'medium' }));
    expect(decision.kind).toBe('allow');
    if (decision.kind !== 'allow') return;
    expect(decision.confirmationMode).toBe('user_confirm');
  });

  it('user_conversation low risk → none', async () => {
    const guard = new ActionGuard({
      permissionChecker: () => true,
      validateParams: validateScaleParams,
    });
    const decision = await guard.decide(makeAction({ risk: 'low' }));
    expect(decision.kind).toBe('allow');
    if (decision.kind !== 'allow') return;
    expect(decision.confirmationMode).toBe('none');
  });

  it('manual_ui mirrors user_conversation', async () => {
    const guard = new ActionGuard({
      permissionChecker: () => true,
      validateParams: validateScaleParams,
    });
    const decision = await guard.decide(
      makeAction({ source: 'manual_ui', risk: 'critical' }),
    );
    expect(decision.kind).toBe('allow');
    if (decision.kind !== 'allow') return;
    expect(decision.confirmationMode).toBe('strong_user_confirm');
  });

  it('connector policy miss → deny', async () => {
    const audit = vi.fn();
    const guard = new ActionGuard({
      permissionChecker: (input) => input.connectorId === 'k8s-prod',
      auditWriter: audit,
      validateParams: validateScaleParams,
    });
    const decision = await guard.decide(makeAction({ connectorId: 'unknown' }));
    expect(decision.kind).toBe('deny');
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({ decision: 'deny' }),
    );
  });

  it('passes verb through to the connector policy checker', async () => {
    const checker = vi.fn().mockReturnValue(true);
    const guard = new ActionGuard({
      permissionChecker: checker,
      validateParams: validateScaleParams,
    });
    await guard.decide(makeAction({ verb: 'rollout' }));
    expect(checker).toHaveBeenCalledWith(expect.objectContaining({ verb: 'rollout' }));
  });

  it('passes capability through to the connector policy checker', async () => {
    const checker = vi.fn().mockReturnValue(false);
    const guard = new ActionGuard({
      permissionChecker: checker,
      validateParams: validateScaleParams,
    });
    const decision = await guard.decide(makeAction({ capability: 'runtime.delete' }));
    expect(decision.kind).toBe('deny');
    expect(checker).toHaveBeenCalledWith(expect.objectContaining({ capability: 'runtime.delete' }));
  });

  it('invalid params → deny', async () => {
    const guard = new ActionGuard({
      permissionChecker: () => true,
      validateParams: validateScaleParams,
    });
    const decision = await guard.decide(
      makeAction({ params: { replicas: -1 } }),
    );
    expect(decision.kind).toBe('deny');
    if (decision.kind !== 'deny') return;
    expect(decision.reason).toContain('replicas must be >= 0');
  });

  it('permission denied → deny (never silently upgrades)', async () => {
    const audit = vi.fn();
    const guard = new ActionGuard({
      permissionChecker: () => false,
      auditWriter: audit,
      validateParams: validateScaleParams,
    });
    const decision = await guard.decide(makeAction());
    expect(decision.kind).toBe('deny');
    if (decision.kind !== 'deny') return;
    expect(decision.reason).toBe('permission denied');
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({ decision: 'deny', reason: 'permission denied' }),
    );
  });

  it('audit row written for both allow and deny', async () => {
    const audit = vi.fn();
    const guard = new ActionGuard({
      permissionChecker: (i) => i.connectorId === 'k8s-prod',
      auditWriter: audit,
      validateParams: validateScaleParams,
    });
    await guard.decide(makeAction());
    await guard.decide(makeAction({ connectorId: 'unknown' }));
    expect(audit).toHaveBeenCalledTimes(2);
    expect(audit.mock.calls[0]![0].decision).toBe('allow');
    expect(audit.mock.calls[1]![0].decision).toBe('deny');
  });

  it('redacts secret-like keys in audit metadata', async () => {
    const audit = vi.fn();
    const guard = new ActionGuard({
      permissionChecker: () => true,
      auditWriter: audit,
      validateParams: validateScaleParams,
    });
    await guard.decide(
      makeAction({
        params: {
          replicas: 3,
          apiKey: 'sk-abc123',
          token: 'bearer-xyz',
          password: 'p@ss',
          nested: { authToken: 'inner', okay: 'fine' },
        },
      }),
    );
    const entry = audit.mock.calls[0]![0];
    expect(entry.paramsRedacted.apiKey).toBe('[REDACTED]');
    expect(entry.paramsRedacted.token).toBe('[REDACTED]');
    expect(entry.paramsRedacted.password).toBe('[REDACTED]');
    expect(entry.paramsRedacted.replicas).toBe(3);
    expect(entry.paramsRedacted.nested.authToken).toBe('[REDACTED]');
    expect(entry.paramsRedacted.nested.okay).toBe('fine');
  });

  it('audit-writer failure does not break decision', async () => {
    const guard = new ActionGuard({
      permissionChecker: () => true,
      auditWriter: () => {
        throw new Error('db down');
      },
      validateParams: validateScaleParams,
    });
    const decision = await guard.decide(makeAction());
    expect(decision.kind).toBe('allow');
  });

  it('passes scope hints through to the connector policy checker', async () => {
    const checker = vi.fn().mockReturnValue(true);
    const guard = new ActionGuard({
      permissionChecker: checker,
      validateParams: validateScaleParams,
    });
    const decision = await guard.decide(
      makeAction({
        connectorId: 'k8s-staging',
        capability: 'runtime.list',
        verb: 'list',
        scope: { namespaces: ['app'] },
        risk: 'low',
      }),
    );
    expect(decision.kind).toBe('allow');
    expect(checker).toHaveBeenCalledWith(
      expect.objectContaining({ connectorId: 'k8s-staging', scope: { namespaces: ['app'] } }),
    );
  });
});

describe('pickConfirmationMode', () => {
  it('matrix', () => {
    expect(pickConfirmationMode('background_agent', 'critical')).toBe('formal_approval');
    expect(pickConfirmationMode('background_agent', 'high')).toBe('formal_approval');
    expect(pickConfirmationMode('background_agent', 'medium')).toBe('none');
    expect(pickConfirmationMode('background_agent', 'low')).toBe('none');

    expect(pickConfirmationMode('user_conversation', 'critical')).toBe('strong_user_confirm');
    expect(pickConfirmationMode('user_conversation', 'high')).toBe('strong_user_confirm');
    expect(pickConfirmationMode('user_conversation', 'medium')).toBe('user_confirm');
    expect(pickConfirmationMode('user_conversation', 'low')).toBe('none');

    expect(pickConfirmationMode('manual_ui', 'critical')).toBe('strong_user_confirm');
    expect(pickConfirmationMode('manual_ui', 'medium')).toBe('user_confirm');

    expect(pickConfirmationMode('system', 'critical')).toBe('none');
  });
});
