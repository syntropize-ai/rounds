/**
 * POST /api/alert-rules/:id/investigate while a dispatcher-created
 * investigation is already attached should return `existing: true` and
 * the same id (Ref PR #128).
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
interface InvestigateResp { investigationId: string; existing: boolean }

describe('investigations/manual-investigate-reuses', () => {
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

  itLLM('manual investigate returns existing dispatcher-created investigation', async () => {
    const prompt =
      'create alert web-api-reuse: PromQL (sum(rate(http_requests_total{app="web-api"}[1m])) or vector(0)) < 1 for 30s severity critical';
    const created = await apiPost<AlertRule>('/api/alert-rules/generate', { prompt });
    ruleId = created.id;
    await scaleDeployment(NS, DEPLOY, 0);

    const linked = await pollUntil<AlertRule>(
      async () => {
        const r = await apiGet<AlertRule>(`/api/alert-rules/${ruleId}`);
        return r.investigationId ? r : null;
      },
      { timeoutMs: 150_000, intervalMs: 3000, label: 'rule.investigationId set' },
    );

    const manual = await apiPost<InvestigateResp>(`/api/alert-rules/${ruleId}/investigate`, {});
    expect(manual.existing).toBe(true);
    expect(manual.investigationId).toBe(linked.investigationId);
  }, 180_000);
});
