/**
 * Scenario 2 — investigation completes.
 *
 * Trigger the same firing pattern, then assert the dispatcher (PR #128)
 * runs an investigation through to completion within 120s and links it
 * back onto the rule.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { apiPost, apiGet, apiDelete } from './helpers/api-client.js';
import { pollUntil } from './helpers/wait.js';
import { scaleDeployment } from './helpers/scale.js';

const NS = 'openobs-e2e';
const DEPLOY = 'web-api';

interface AlertRule {
  id: string;
  state: string;
  investigationId?: string;
}
interface Investigation {
  id: string;
  status: 'planning' | 'investigating' | 'evidencing' | 'explaining' | 'acting' | 'verifying' | 'completed' | 'failed';
}

describe.skipIf(!process.env['OPENOBS_TEST_LLM_API_KEY'])('investigation-completes', () => {
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

  it('dispatcher runs investigation to completion and links it on the rule', async () => {
    const prompt =
      'create alert web-api-down-inv: PromQL (sum(rate(http_requests_total{app="web-api"}[1m])) or vector(0)) < 1 for 30s severity critical';
    const created = await apiPost<AlertRule>('/api/alert-rules/generate', { prompt });
    ruleId = created.id;
    await scaleDeployment(NS, DEPLOY, 0);

    // Wait for fire first — investigation is dispatched on transition.
    await pollUntil<AlertRule>(
      async () => {
        const rule = await apiGet<AlertRule>(`/api/alert-rules/${ruleId}`);
        return rule.state === 'firing' ? rule : null;
      },
      { timeoutMs: 90_000, intervalMs: 3000, label: 'rule -> firing' },
    );

    // Investigation is linked onto the rule and its status reaches `completed`.
    const linked = await pollUntil<AlertRule>(
      async () => {
        const rule = await apiGet<AlertRule>(`/api/alert-rules/${ruleId}`);
        return rule.investigationId ? rule : null;
      },
      { timeoutMs: 60_000, intervalMs: 2000, label: 'rule.investigationId set' },
    );
    expect(linked.investigationId).toBeTruthy();

    const inv = await pollUntil<Investigation>(
      async () => {
        const i = await apiGet<Investigation>(`/api/investigations/${linked.investigationId}`);
        return i.status === 'completed' ? i : null;
      },
      { timeoutMs: 120_000, intervalMs: 3000, label: 'investigation -> completed' },
    );
    expect(inv.status).toBe('completed');
  }, 180_000);
});
