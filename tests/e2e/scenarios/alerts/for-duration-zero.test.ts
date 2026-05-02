/**
 * forDurationSec = 0 should fire on the first evaluator tick that sees
 * the condition true — no `pending` window required.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { apiPost, apiGet, apiDelete } from '../helpers/api-client.js';
import { pollUntil } from '../helpers/wait.js';
import { scaleDeployment } from '../helpers/scale.js';

const NS = 'openobs-e2e';
const DEPLOY = 'web-api';

interface AlertRule { id: string; state: string; condition?: { forDurationSec?: number } }

describe('alerts/for-duration-zero', () => {
  let ruleId: string | null = null;

  beforeAll(async () => {
    await scaleDeployment(NS, DEPLOY, 0);
  }, 180_000);

  afterAll(async () => {
    if (ruleId) {
      try { await apiDelete(`/api/alert-rules/${ruleId}`); } catch { /* noop */ }
    }
    try { await scaleDeployment(NS, DEPLOY, 3); } catch { /* noop */ }
  }, 180_000);

  it('forDurationSec=0 fires on the first true evaluation', async () => {
    // Create rule directly so we can pin forDurationSec=0; the LLM
    // /generate endpoint does not promise to honor "0s".
    const created = await apiPost<AlertRule>('/api/alert-rules', {
      name: 'web-api-for0',
      condition: {
        query: '(sum(rate(http_requests_total{app="web-api"}[1m])) or vector(0)) < 1',
        operator: '<',
        threshold: 1,
        forDurationSec: 0,
      },
      severity: 'critical',
      evaluationIntervalSec: 30,
    });
    ruleId = created.id;

    const fired = await pollUntil<AlertRule>(
      async () => {
        const r = await apiGet<AlertRule>(`/api/alert-rules/${ruleId}`);
        return r.state === 'firing' ? r : null;
      },
      { timeoutMs: 180_000, intervalMs: 2000, label: 'forDur=0 rule -> firing' },
    );
    expect(fired.state).toBe('firing');
  }, 180_000);
});
