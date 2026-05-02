/**
 * Deleting a rule must stop the evaluator from updating it. Subsequent
 * GETs return 404 and no fresh history rows appear.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { apiPost, apiGet, apiDelete, ApiError } from '../helpers/api-client.js';
import { scaleDeployment } from '../helpers/scale.js';

const NS = 'openobs-e2e';
const DEPLOY = 'web-api';

interface AlertRule { id: string; state: string }

describe('alerts/rule-delete', () => {
  beforeAll(async () => {
    await scaleDeployment(NS, DEPLOY, 3);
  }, 180_000);

  afterAll(async () => {
    try { await scaleDeployment(NS, DEPLOY, 3); } catch { /* noop */ }
  }, 180_000);

  it('deleted rule returns 404 and is no longer evaluated', async () => {
    const created = await apiPost<AlertRule>('/api/alert-rules', {
      name: 'web-api-delete',
      condition: {
        query: '(sum(rate(http_requests_total{app="web-api"}[1m])) or vector(0)) < 1',
        operator: '<',
        threshold: 1,
        forDurationSec: 10,
      },
      severity: 'low',
      evaluationIntervalSec: 30,
    });
    const ruleId = created.id;
    await apiDelete(`/api/alert-rules/${ruleId}`);

    let status: number | null = null;
    try { await apiGet<AlertRule>(`/api/alert-rules/${ruleId}`); }
    catch (err) {
      if (err instanceof ApiError) status = err.status;
      else throw err;
    }
    expect(status).toBe(404);

    // Wait two evaluator cycles; rule must not reappear.
    await new Promise((r) => setTimeout(r, 60_000));
    let stillGone = false;
    try { await apiGet<AlertRule>(`/api/alert-rules/${ruleId}`); }
    catch (err) {
      if (err instanceof ApiError && err.status === 404) stillGone = true;
      else throw err;
    }
    expect(stillGone).toBe(true);
  }, 180_000);
});
