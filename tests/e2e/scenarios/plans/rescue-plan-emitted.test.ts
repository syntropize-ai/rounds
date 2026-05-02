/**
 * For a reversible scale plan, the agent may emit a rescue plan with
 * `rescueForPlanId` set to the primary plan's id. Whether or not the
 * model emits one is non-deterministic, so this test self-skips when
 * the rescue isn't present.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { apiPost, apiGet, apiDelete } from '../helpers/api-client.js';
import { pollUntil } from '../helpers/wait.js';
import { scaleDeployment } from '../helpers/scale.js';
import { skipWithoutLLM } from '../helpers/llm.js';

const NS = 'openobs-e2e';
const DEPLOY = 'web-api';
const itLLM = skipWithoutLLM(it);

interface AlertRule { id: string; state: string; investigationId?: string }
interface Plan { id: string; status: string; investigationId: string; rescueForPlanId?: string | null }

describe('plans/rescue-plan-emitted', () => {
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

  itLLM('reversible scale plan optionally emits a rescue plan', async () => {
    const prompt =
      'create alert web-api-rescue: PromQL (sum(rate(http_requests_total{app="web-api"}[1m])) or vector(0)) < 1 for 30s severity critical';
    const created = await apiPost<AlertRule>('/api/alert-rules/generate', { prompt });
    ruleId = created.id;
    await scaleDeployment(NS, DEPLOY, 0);

    const linked = await pollUntil<AlertRule>(
      async () => {
        const r = await apiGet<AlertRule>(`/api/alert-rules/${ruleId}`);
        return r.investigationId ? r : null;
      },
      { timeoutMs: 150_000, intervalMs: 3000, label: 'investigation linked' },
    );

    const plans = await pollUntil<Plan[]>(
      async () => {
        const list = await apiGet<Plan[]>(
          `/api/plans?investigationId=${encodeURIComponent(linked.investigationId!)}`,
        );
        return Array.isArray(list) && list.length > 0 ? list : null;
      },
      { timeoutMs: 180_000, intervalMs: 3000, label: 'plans listed for investigation' },
    );

    const primary = plans.find((p) => !p.rescueForPlanId);
    const rescue = plans.find((p) => p.rescueForPlanId);
    if (!rescue) {
      // Model didn't emit a rescue this run — that's allowed by the
      // orchestrator-prompt contract. Skip the assertion path.
      // eslint-disable-next-line no-console
      console.warn('[rescue-plan-emitted] no rescue plan emitted, skipping');
      return;
    }
    expect(primary, 'expected a primary plan to exist alongside the rescue').toBeDefined();
    expect(rescue.rescueForPlanId).toBe(primary!.id);
  }, 180_000);
});
