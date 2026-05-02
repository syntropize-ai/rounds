/**
 * Reject a pending plan via /api/plans/:id/reject; assert status =
 * `rejected`, web-api stays at 0 replicas (no remediation), alert keeps
 * firing.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { apiPost, apiGet, apiDelete } from '../helpers/api-client.js';
import { pollUntil } from '../helpers/wait.js';
import { scaleDeployment } from '../helpers/scale.js';
import { skipWithoutLLM } from '../helpers/llm.js';
import { spawn } from 'node:child_process';

const NS = 'openobs-e2e';
const DEPLOY = 'web-api';
const itLLM = skipWithoutLLM(it);

interface AlertRule { id: string; state: string; investigationId?: string }
interface Plan { id: string; status: string; investigationId: string }

function kubectlReplicas(ns: string, name: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const p = spawn('kubectl', [
      'get', 'deploy', name, '-n', ns, '-o', 'jsonpath={.status.replicas}',
    ], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    p.stdout.on('data', (b) => (out += b.toString()));
    p.on('error', reject);
    p.on('close', () => resolve(Number.parseInt(out.trim() || '0', 10)));
  });
}

describe('plans/plan-rejected', () => {
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

  itLLM('rejecting a plan leaves the workload broken and the alert firing', async () => {
    const prompt =
      'create alert web-api-reject: PromQL (sum(rate(http_requests_total{app="web-api"}[1m])) or vector(0)) < 1 for 30s severity critical';
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
          `/api/plans?status=pending_approval&investigationId=${encodeURIComponent(linked.investigationId!)}`,
        );
        return Array.isArray(list) && list.length > 0 ? list : null;
      },
      { timeoutMs: 180_000, intervalMs: 3000, label: 'plan in pending_approval' },
    );
    const planId = plans[0]!.id;
    await apiPost(`/api/plans/${planId}/reject`, {});

    const finalPlan = await apiGet<Plan>(`/api/plans/${planId}`);
    expect(finalPlan.status).toBe('rejected');

    const replicas = await kubectlReplicas(NS, DEPLOY);
    expect(replicas).toBe(0);

    const rule = await apiGet<AlertRule>(`/api/alert-rules/${ruleId}`);
    expect(rule.state).toBe('firing');
  }, 180_000);
});
