/**
 * Regression for PR #127 hypothesis-ordering: a web-api-down scenario
 * with the prometheus datasource healthy must NOT conclude that the
 * datasource is misconfigured.
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
interface Investigation { id: string; status: string; summary?: string; report?: { summary?: string } }

describe('investigations/metric-drop-no-misdiagnosis', () => {
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

  itLLM('web-api-down summary does not blame the datasource', async () => {
    const prompt =
      'create alert web-api-no-misdx: PromQL (sum(rate(http_requests_total{app="web-api"}[1m])) or vector(0)) < 1 for 30s severity critical';
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

    const inv = await pollUntil<Investigation>(
      async () => {
        const i = await apiGet<Investigation>(`/api/investigations/${linked.investigationId}`);
        return i.status === 'completed' ? i : null;
      },
      { timeoutMs: 180_000, intervalMs: 3000, label: 'investigation -> completed' },
    );
    const summary = (inv.summary ?? inv.report?.summary ?? '').toLowerCase();
    expect(summary, 'expected non-empty summary').not.toBe('');
    expect(summary).not.toMatch(/datasource\s+(mis)?config|prometheus\s+misconfigured|wrong\s+datasource|datasource\s+down/);
  }, 180_000);
});
