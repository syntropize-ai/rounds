/**
 * Scenario 3 — plan proposed.
 *
 * Same firing trigger; assert the auto-remediation pipeline produces a
 * plan in `pending_approval` linked to the investigation, and that the
 * plan contains a `kubectl scale` step (the obvious fix for the failure
 * we induced).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { apiPost, apiGet, apiDelete } from './helpers/api-client.js';
import { pollUntil } from './helpers/wait.js';
import { scaleDeployment } from './helpers/scale.js';

const NS = 'openobs-e2e';
const DEPLOY = 'web-api';

interface AlertRule { id: string; state: string; investigationId?: string }
interface PlanStep { commandText: string; status: string; ordinal: number }
interface Plan {
  id: string;
  status: string;
  investigationId: string;
  steps: PlanStep[];
}

describe.skipIf(!process.env['OPENOBS_TEST_LLM_API_KEY'])('plan-proposed', () => {
  let ruleId: string | null = null;

  beforeAll(async () => {
    await scaleDeployment(NS, DEPLOY, 3);
  }, 180_000);

  afterAll(async () => {
    if (ruleId) {
      try { await apiDelete(`/api/alert-rules/${ruleId}`); } catch { /* noop */ }
    }
    try { await scaleDeployment(NS, DEPLOY, 3); } catch { /* noop */ }
  }, 180_000);

  it('produces a pending_approval plan with a kubectl scale step', async () => {
    const prompt =
      'create alert web-api-down-plan: PromQL (sum(rate(http_requests_total{app="web-api"}[1m])) or vector(0)) < 1 for 30s severity critical';
    const created = await apiPost<AlertRule>('/api/alert-rules/generate', { prompt });
    ruleId = created.id;
    await scaleDeployment(NS, DEPLOY, 0);

    const linked = await pollUntil<AlertRule>(
      async () => {
        const rule = await apiGet<AlertRule>(`/api/alert-rules/${ruleId}`);
        return rule.investigationId ? rule : null;
      },
      { timeoutMs: 120_000, intervalMs: 3000, label: 'rule -> firing + investigation linked' },
    );
    const investigationId = linked.investigationId!;

    const plans = await pollUntil<Plan[]>(
      async () => {
        const list = await apiGet<Plan[]>(
          `/api/plans?status=pending_approval&investigationId=${encodeURIComponent(investigationId)}`,
        );
        return Array.isArray(list) && list.length > 0 ? list : null;
      },
      { timeoutMs: 180_000, intervalMs: 3000, label: 'plan in pending_approval' },
    );
    const plan = plans[0]!;
    expect(plan.investigationId).toBe(investigationId);
    expect(plan.status).toBe('pending_approval');
    const scaleStep = plan.steps.find(
      (s) => s.commandText.includes('kubectl scale') && s.commandText.includes('replicas'),
    );
    expect(scaleStep, `expected a kubectl scale step in plan ${plan.id}`).toBeDefined();
  }, 180_000);
});
