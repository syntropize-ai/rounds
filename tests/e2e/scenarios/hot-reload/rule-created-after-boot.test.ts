/**
 * Rules created after boot must be picked up by the evaluator without a
 * restart. The harness pins ALERT_EVALUATOR_REFRESH_MS=3600000 so this
 * currently FAILS — wrapped in `it.fails` to track the open todo
 * "Evaluator misses rules created after boot".
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { apiPost, apiGet, apiDelete } from '../helpers/api-client.js';
import { pollUntil } from '../helpers/wait.js';
import { scaleDeployment } from '../helpers/scale.js';

const NS = 'openobs-e2e';
const DEPLOY = 'web-api';

interface AlertRule { id: string; state: string }

describe('hot-reload/rule-created-after-boot', () => {
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

  // Tracked failure: ALERT_EVALUATOR_REFRESH_MS=3600000 in the harness
  // means the evaluator only reloads the rule cache once per hour.
  // When that knob is fixed, drop `it.fails` -> `it`.
  it.fails('newly-created rule fires within 90s without an evaluator restart', async () => {
    const created = await apiPost<AlertRule>('/api/alert-rules', {
      name: 'web-api-hotreload',
      condition: {
        query: '(sum(rate(http_requests_total{app="web-api"}[1m])) or vector(0)) < 1',
        operator: '<',
        threshold: 1,
        forDurationSec: 30,
      },
      severity: 'medium',
      evaluationIntervalSec: 30,
    });
    ruleId = created.id;

    await scaleDeployment(NS, DEPLOY, 0);

    const fired = await pollUntil<AlertRule>(
      async () => {
        const r = await apiGet<AlertRule>(`/api/alert-rules/${ruleId}`);
        return r.state === 'firing' ? r : null;
      },
      { timeoutMs: 90_000, intervalMs: 3000, label: 'post-boot rule -> firing' },
    );
    expect(fired.state).toBe('firing');
  }, 180_000);
});
