/**
 * Scenario 4 — marquee. Plan approve + execute end-to-end.
 *
 * Full chain: alert fires -> investigation -> plan proposed -> approve
 * -> execute -> web-api scaled back up by openobs -> alert resolves.
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

describe.skipIf(!process.env['OPENOBS_TEST_LLM_API_KEY'])('plan-approve-and-execute', () => {
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

  it('approving the plan executes it, restores web-api, and resolves the alert', async () => {
    const prompt =
      'create alert web-api-down-exec: PromQL (sum(rate(http_requests_total{app="web-api"}[1m])) or vector(0)) < 1 for 30s severity critical';
    const created = await apiPost<AlertRule>('/api/alert-rules/generate', { prompt });
    ruleId = created.id;
    await scaleDeployment(NS, DEPLOY, 0);

    const linked = await pollUntil<AlertRule>(
      async () => {
        const rule = await apiGet<AlertRule>(`/api/alert-rules/${ruleId}`);
        return rule.investigationId ? rule : null;
      },
      { timeoutMs: 120_000, intervalMs: 3000, label: 'rule -> firing + investigation' },
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

    // Approve. The executor runs synchronously up to either completion
    // or the next pause; we still poll the plan resource because the
    // outcome shape is too narrow to assert the post-state.
    await apiPost(`/api/plans/${plan.id}/approve`, { autoEdit: false });

    const finalPlan = await pollUntil<Plan>(
      async () => {
        const p = await apiGet<Plan>(`/api/plans/${plan.id}`);
        return p.status === 'completed' ? p : null;
      },
      { timeoutMs: 60_000, intervalMs: 2000, label: `plan ${plan.id} -> completed` },
    );
    expect(finalPlan.status).toBe('completed');
    for (const s of finalPlan.steps) {
      expect(s.status, `step ${s.ordinal} status`).toBe('done');
    }

    // The plan should have scaled web-api back up; the rule should
    // resolve once the rate climbs back over the threshold.
    await pollUntil<AlertRule>(
      async () => {
        const rule = await apiGet<AlertRule>(`/api/alert-rules/${ruleId}`);
        return rule.state === 'normal' || rule.state === 'resolved' ? rule : null;
      },
      { timeoutMs: 120_000, intervalMs: 3000, label: 'rule resolves after remediation' },
    );
  }, 180_000);
});
