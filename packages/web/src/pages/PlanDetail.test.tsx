/**
 * Pure-render / pure-logic tests for PlanDetail. The web package does not
 * pull in jsdom, so we use renderToStaticMarkup (same pattern as
 * AlertRuleEdit.test.tsx) and exercise the action-error path through the real
 * plansApi with a stubbed `fetch`.
 */

import React from 'react';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { RescuePlanPanel, planActionError } from './PlanDetail.js';
import { plansApi } from '../api/client.js';
import type { RemediationPlan, RemediationPlanStatus } from '../api/client.js';

function makePlan(id: string, status: RemediationPlanStatus): RemediationPlan {
  return {
    id,
    orgId: 'org-1',
    investigationId: 'inv-1',
    rescueForPlanId: null,
    summary: 'Scale the deployment back up',
    status,
    autoEdit: false,
    approvalRequestId: null,
    linkedAlertRuleId: null,
    targetObject: null,
    validationMethod: null,
    verificationStatus: 'not_started',
    verificationStartedAt: null,
    verificationDeadlineAt: null,
    verificationEvidenceJson: null,
    continuationInvestigationId: null,
    createdBy: 'agent',
    createdAt: '2026-05-08T00:00:00.000Z',
    expiresAt: '2026-05-09T00:00:00.000Z',
    resolvedAt: null,
    resolvedBy: null,
    steps: [],
  };
}

function renderRescue(status: RemediationPlanStatus, rescue: RemediationPlan | null): string {
  return renderToStaticMarkup(
    <MemoryRouter>
      <RescuePlanPanel plan={makePlan('plan-1', status)} rescuePlan={rescue} />
    </MemoryRouter>,
  );
}

describe('RescuePlanPanel', () => {
  const rescue = makePlan('rescue-1', 'pending_approval');

  it('offers the rescue plan when execution failed', () => {
    const html = renderRescue('execution_failed', rescue);
    expect(html).toContain('Rescue plan available');
    expect(html).toContain('Open rescue plan');
    expect(html).toContain('href="/plans/rescue-1"');
  });

  it('still offers the rescue plan for the legacy `failed` status', () => {
    expect(renderRescue('failed', rescue)).toContain('Open rescue plan');
  });

  it('renders nothing while the plan has not failed', () => {
    expect(renderRescue('completed', rescue)).toBe('');
    expect(renderRescue('executing', rescue)).toBe('');
  });

  it('renders nothing when no rescue plan was generated', () => {
    expect(renderRescue('execution_failed', null)).toBe('');
  });
});

describe('planActionError', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('surfaces the server message when approve fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify({ error: { code: 'PLAN_EXPIRED', message: 'Plan already expired' } }),
      { status: 409, headers: { 'Content-Type': 'application/json' } },
    )));

    const message = await planActionError('Approve', () => plansApi.approve('plan-1', true));

    expect(message).toBe('Approve failed: Plan already expired');
  });

  it('returns null when the call succeeds', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify({ outcome: { kind: 'completed' }, plan: null }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    )));

    const message = await planActionError('Approve', () => plansApi.approve('plan-1', true));

    expect(message).toBeNull();
  });
});
