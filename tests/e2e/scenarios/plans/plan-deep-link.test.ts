/**
 * GET /api/plans?investigationId=<id> should return the plan(s) linked
 * to the investigation (Ref PR #124 / #129 InvestigationPlanBanner).
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
interface Plan { id: string; status: string; investigationId: string }

describe('plans/plan-deep-link', () => {
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

  itLLM('GET /api/plans?investigationId=... returns the linked plan', async () => {
    const prompt =
      'create alert web-api-deeplink: PromQL (sum(rate(http_requests_total{app="web-api"}[1m])) or vector(0)) < 1 for 30s severity critical';
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
      { timeoutMs: 180_000, intervalMs: 3000, label: 'plans?investigationId=' },
    );
    expect(plans.length).toBeGreaterThan(0);
    for (const p of plans) {
      expect(p.investigationId).toBe(linked.investigationId);
    }
  }, 180_000);
});
