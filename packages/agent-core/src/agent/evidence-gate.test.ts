import { describe, it, expect } from 'vitest';
import { validateRemediationPlanEvidence } from './evidence-gate.js';
import type { RootCauseEvidenceGateResult } from './evidence-gate.js';
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

  it('still matches a single-token root cause on that one token', () => {
    const result = validateRemediationPlanEvidence([reportWithGate('checkout')], {
      targetObject: 'checkout',
      validationMethod: 'verify p99 returns to baseline',
    });

    expect(result.status).toBe('passed');
  });
});
