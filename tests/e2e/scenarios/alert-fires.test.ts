/**
 * Scenario 1 — alert fires.
 *
 * 1. Scale web-api up so the metric exists and rate > 0.
 * 2. Generate an alert rule with a PromQL that triggers when web-api is
 *    serving zero traffic.
 * 3. Scale web-api to 0; rate falls; rule transitions normal -> pending
 *    -> firing within 90s.
 *
 * No LLM dependency for the assertion path itself, but the
 * `/api/alert-rules/generate` endpoint does need an LLM configured (the
 * test cluster is set up that way by seed.sh).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { apiPost, apiGet, apiDelete } from './helpers/api-client.js';
import { pollUntil } from './helpers/wait.js';
import { scaleDeployment } from './helpers/scale.js';

const NS = 'openobs-e2e';
const DEPLOY = 'web-api';
const RULE_TIMEOUT_MS = 90_000;

interface AlertRule {
  id: string;
  name: string;
  state: 'normal' | 'pending' | 'firing' | 'resolved' | 'disabled';
  investigationId?: string;
}

describe('alert-fires', () => {
  let ruleId: string | null = null;

  beforeAll(async () => {
    await scaleDeployment(NS, DEPLOY, 3);
  }, 180_000);

  afterAll(async () => {
    // Best-effort cleanup. Either step failing must not mask test failure.
    if (ruleId) {
      try { await apiDelete(`/api/alert-rules/${ruleId}`); } catch { /* noop */ }
    }
    try { await scaleDeployment(NS, DEPLOY, 3); } catch { /* noop */ }
  }, 180_000);

  it('rule transitions normal -> firing when web-api is scaled to 0', async () => {
    const prompt =
      'create alert web-api-down: PromQL (sum(rate(http_requests_total{app="web-api"}[1m])) or vector(0)) < 1 for 30s severity critical';
    const created = await apiPost<AlertRule>('/api/alert-rules/generate', { prompt });
    expect(created.id).toBeTruthy();
    ruleId = created.id;

    // Knock the workload out — the alert rule's evaluator should now
    // start counting 'pending' time and tip into firing after the for-30s
    // window plus an evaluation interval or two.
    await scaleDeployment(NS, DEPLOY, 0);

    const fired = await pollUntil<AlertRule>(
      async () => {
        const rule = await apiGet<AlertRule>(`/api/alert-rules/${ruleId}`);
        return rule.state === 'firing' ? rule : null;
      },
      { timeoutMs: RULE_TIMEOUT_MS, intervalMs: 3000, label: `rule ${ruleId} -> firing` },
    );
    expect(fired.state).toBe('firing');
  }, 180_000);
});
