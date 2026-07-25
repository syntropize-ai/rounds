import { describe, it, expect } from 'vitest';
import { evaluateInvestigationEvidenceGate, validateRemediationPlanEvidence } from './evidence-gate.js';
import type { RootCauseEvidenceGateResult } from './evidence-gate.js';
import type {
  InvestigationCheck,
  InvestigationCompletionClaim,
} from './investigation-state.js';
import type { SavedInvestigationReport } from '@agentic-obs/common';

function reportWithGate(rootObject: string, field = ''): SavedInvestigationReport {
  const gate: RootCauseEvidenceGateResult = {
    status: 'passed',
    reasons: [],
    rootCause: { status: 'confirmed', object: rootObject, field, cause: 'bad rollout' },
    confidence: 0.9,
    evidenceRefs: ['check_1', 'check_2'],
    ruledOut: ['unrelated traffic shift'],
    evaluatedAt: '2026-01-01T00:00:00.000Z',
  };
  return {
    id: 'report_1',
    dashboardId: 'inv_1',
    goal: 'why is it slow',
    summary: 'rollout regression',
    sections: [],
    createdAt: '2026-01-01T00:00:00.000Z',
    provenance: { rootCauseGate: gate },
  } as unknown as SavedInvestigationReport;
}

const NOW = '2026-07-20T12:00:00.000Z';

function chineseChecks(): InvestigationCheck[] {
  return [
    {
      id: 'check_1',
      hypothesis: '订单服务因内存上限过低而反复重启',
      signalType: 'kubernetes',
      tool: 'ops_run_command',
      query: 'kubectl describe pod',
      result: '订单服务容器上次终止原因为内存不足,内存上限过低',
      interpretation: '支持内存上限过低导致容器反复重启的判断。',
      status: 'supported',
      scope: { timeWindow: '最近三十分钟', affected: '生产环境的订单服务' },
    },
    {
      id: 'check_2',
      hypothesis: '错误率上升是流量激增造成的',
      signalType: 'metric',
      tool: 'metrics_range_query',
      query: '请求速率与错误率',
      result: '请求速率保持平稳,错误只出现在订单服务上',
      interpretation: '排除流量激增这一解释。',
      status: 'ruled_out',
      scope: { timeWindow: '最近三十分钟', affected: '生产环境' },
    },
  ];
}

function chineseClaim(): InvestigationCompletionClaim {
  return {
    rootCause: {
      status: 'confirmed',
      object: '订单服务',
      field: '内存上限',
      cause: '内存上限过低导致容器反复重启',
    },
    confidence: 0.88,
    evidenceRefs: ['check_1', 'check_2'],
    ruledOut: ['流量激增'],
    validationMethod: '调高内存上限后观察容器重启次数是否归零',
    nextAction: '把订单服务的内存上限调到 512Mi',
  };
}

function englishChecks(scoped: boolean): InvestigationCheck[] {
  return [
    {
      id: 'check_1',
      hypothesis: 'reviews-v2 is OOMKilled',
      signalType: 'kubernetes',
      tool: 'ops_run_command',
      query: 'kubectl describe pod reviews-v2',
      result: 'reviews-v2 is OOMKilled caused by memory pressure',
      interpretation: 'Supports a memory limit that is too low for the workload.',
      status: 'supported',
      scope: scoped ? { timeWindow: '2026-07-20T11:30Z..12:00Z', affected: 'Deployment/reviews-v2 in namespace prod' } : {},
    },
    {
      id: 'check_2',
      hypothesis: 'the errors are caused by a traffic spike',
      signalType: 'metric',
      tool: 'metrics_range_query',
      query: 'rate(istio_requests_total[5m])',
      result: 'request rate is flat and 5xx is isolated to reviews-v2',
      interpretation: 'Rules out a traffic spike.',
      status: 'ruled_out',
      scope: scoped ? { affected: 'namespace prod' } : {},
    },
  ];
}

function englishClaim(): InvestigationCompletionClaim {
  return {
    rootCause: {
      status: 'confirmed',
      object: 'Deployment/reviews-v2',
      field: 'resources.limits.memory',
      cause: 'memory limit too low causing OOMKilled restarts',
    },
    confidence: 0.88,
    evidenceRefs: ['check_1', 'check_2'],
    ruledOut: ['traffic spike'],
    validationMethod: 'verify container restarts drop to zero after raising the limit',
    nextAction: 'Raise resources.limits.memory to 512Mi',
  };
}

describe('evaluateInvestigationEvidenceGate — structured scope and validation fields', () => {
  it('passes a fully-evidenced Chinese-language investigation', () => {
    const result = evaluateInvestigationEvidenceGate(
      { checks: chineseChecks(), hypotheses: [] },
      chineseClaim(),
      NOW,
    );

    expect(result.reasons).toEqual([]);
    expect(result.status).toBe('passed');
  });

  it('fails an English claim whose referenced evidence carries no recorded scope', () => {
    // Anti-vacuity: this narrative satisfied the old keyword regex on
    // ordinary words ("caused by", "[5m]"), so prose-sniffing passed the
    // claim while the checks said nothing about when or where the
    // observation applies. Now it fails on the missing structured scope.
    const result = evaluateInvestigationEvidenceGate(
      { checks: englishChecks(false), hypotheses: [] },
      englishClaim(),
      NOW,
    );

    expect(result.status).toBe('unresolved');
    expect(result.reasons).toEqual([
      'at least one referenced check must record scope.timeWindow or scope.affected',
    ]);
  });

  it('fails a claim that omits validationMethod even when nextAction talks about verifying', () => {
    const result = evaluateInvestigationEvidenceGate(
      { checks: englishChecks(true), hypotheses: [] },
      {
        ...englishClaim(),
        validationMethod: undefined,
        nextAction: 'Raise the limit, then verify restarts return to baseline.',
      },
      NOW,
    );

    expect(result.status).toBe('unresolved');
    expect(result.reasons).toEqual([
      'validationMethod must state how to validate the fix or next finding',
    ]);
  });

  it('passes a well-formed English claim', () => {
    const result = evaluateInvestigationEvidenceGate(
      { checks: englishChecks(true), hypotheses: [] },
      englishClaim(),
      NOW,
    );

    expect(result.reasons).toEqual([]);
    expect(result.status).toBe('passed');
  });
});

describe('validateRemediationPlanEvidence — repair target must match the proven root cause', () => {
  it('rejects a plan whose target only shares a generic token with the root cause', () => {
    const result = validateRemediationPlanEvidence([reportWithGate('deploy/web')], {
      targetObject: 'deploy/api',
      validationMethod: 'verify rollout status returns to baseline',
    });

    expect(result.status).toBe('rejected');
    expect(result.reasons).toContain('plan target does not match the verified root-cause object or field');
  });

  it('accepts the plan that names the proven object', () => {
    const result = validateRemediationPlanEvidence([reportWithGate('deploy/web')], {
      targetObject: 'deploy/web',
      validationMethod: 'verify rollout status returns to baseline',
    });

    expect(result.status).toBe('passed');
    expect(result.reasons).toEqual([]);
  });

  it('matches on object + field when the target names both', () => {
    const result = validateRemediationPlanEvidence([reportWithGate('EnvoyFilter/foo', 'filter_chain_match')], {
      targetObject: 'EnvoyFilter foo filter_chain_match',
      validationMethod: 'confirm the failing path recovers',
    });

    expect(result.status).toBe('passed');
  });

  it('accepts a validation method written in the user\'s language', () => {
    const result = validateRemediationPlanEvidence([reportWithGate('deploy/web')], {
      targetObject: 'deploy/web',
      validationMethod: '观察 p99 延迟是否回到基线',
    });

    expect(result.status).toBe('passed');
  });

  it('rejects a plan with an empty validation method', () => {
    const result = validateRemediationPlanEvidence([reportWithGate('deploy/web')], {
      targetObject: 'deploy/web',
      validationMethod: '   ',
    });

    expect(result.reasons).toContain('plan must include an explicit verification or validation method');
  });

  it('still matches a single-token root cause on that one token', () => {
    const result = validateRemediationPlanEvidence([reportWithGate('checkout')], {
      targetObject: 'checkout',
      validationMethod: 'verify p99 returns to baseline',
    });

    expect(result.status).toBe('passed');
  });
});
