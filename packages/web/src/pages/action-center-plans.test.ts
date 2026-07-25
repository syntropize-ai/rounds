import { describe, it, expect } from 'vitest';
import { ACTIONABLE_PLAN_STATUSES, planCtaLabel } from './ActionCenter.js';
import type { RemediationPlan } from '../api/client.js';

function plan(over: Partial<RemediationPlan>): RemediationPlan {
  return {
    id: 'plan_1',
    investigationId: 'inv_1',
    summary: 'restart the deployment',
    status: 'applied',
    steps: [],
    createdAt: '2026-01-01T00:00:00.000Z',
    expiresAt: '2026-01-02T00:00:00.000Z',
    ...over,
  } as unknown as RemediationPlan;
}

describe('Action Center plan queue', () => {
  it('loads every status its CTA labels can render', () => {
    // Regression guard: the queue used to fetch only `pending_approval`, which
    // made every label below unreachable and hid failed remediations — the
    // plans that most need an operator.
    const labelToPlan: Array<[string, RemediationPlan]> = [
      ['Review', plan({ status: 'pending_approval' })],
      ['Verifying', plan({ status: 'applied', verificationStatus: 'waiting' })],
      ['Fixed', plan({ status: 'applied', verificationStatus: 'passed' })],
      ['Ineffective', plan({ status: 'applied', verificationStatus: 'failed' })],
      ['Needs review', plan({ status: 'applied', verificationStatus: 'inconclusive' })],
      ['Failed', plan({ status: 'execution_failed' })],
    ];

    for (const [label, p] of labelToPlan) {
      expect(planCtaLabel(p)).toBe(label);
      expect(ACTIONABLE_PLAN_STATUSES).toContain(p.status);
    }
  });

  it('leaves terminal states out of the queue', () => {
    for (const terminal of ['completed', 'rejected', 'expired', 'cancelled', 'draft']) {
      expect(ACTIONABLE_PLAN_STATUSES).not.toContain(terminal);
    }
  });
});
