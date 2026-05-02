/**
 * PUT /api/alert-rules/:id changing the threshold should be picked up by
 * the evaluator within one safety-net cycle. If hot-reload is regressed
 * (eg ALERT_EVALUATOR_REFRESH_MS pinned high) this test will be flaky —
 * mark `it.fails` and link the open todo.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { apiPost, apiGet, apiPut, apiDelete } from '../helpers/api-client.js';
import { pollUntil } from '../helpers/wait.js';
import { scaleDeployment } from '../helpers/scale.js';

const NS = 'openobs-e2e';
const DEPLOY = 'web-api';

interface AlertRule {
  id: string;
  state: string;
  condition: { query: string; operator: string; threshold: number; forDurationSec?: number };
}

describe('alerts/rule-edit-via-put', () => {
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

  // PR #128 wired evaluator hot-reload through EventEmittingAlertRuleRepository,
  // so PUT changes are visible without a process restart.
  it('PUT threshold is honored within one evaluator cycle', async () => {
    // Create a rule with a threshold that will NOT trigger at full traffic.
    const created = await apiPost<AlertRule>('/api/alert-rules', {
      name: 'web-api-edit',
      condition: {
        query: '(sum(rate(http_requests_total{app="web-api"}[1m])) or vector(0)) < 1',
        operator: '<',
        threshold: -1, // never true
        forDurationSec: 10,
      },
      severity: 'medium',
      evaluationIntervalSec: 30,
    });
    ruleId = created.id;

    await scaleDeployment(NS, DEPLOY, 0);

    // Confirm not firing (threshold is impossible).
    const r1 = await apiGet<AlertRule>(`/api/alert-rules/${ruleId}`);
    expect(r1.state).not.toBe('firing');

    // Lower threshold so the rule should now fire.
    await apiPut(`/api/alert-rules/${ruleId}`, {
      condition: { ...r1.condition, threshold: 1 },
    });

    const fired = await pollUntil<AlertRule>(
      async () => {
        const r = await apiGet<AlertRule>(`/api/alert-rules/${ruleId}`);
        return r.state === 'firing' ? r : null;
      },
      { timeoutMs: 120_000, intervalMs: 3000, label: 'edited rule -> firing' },
    );
    expect(fired.state).toBe('firing');
  }, 180_000);
});
