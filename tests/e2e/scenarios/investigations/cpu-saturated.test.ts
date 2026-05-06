/**
 * Scenario — CPU saturation triggers an investigation that completes.
 *
 * Companion to investigation-completes.test.ts (which uses scale-to-0 / no
 * traffic as the firing condition). Here the symptom is the opposite:
 * the target is up and serving, but its process is pinned against its
 * container CPU limit. Exercises the agent's investigation flow on a
 * "service is alive but degraded" failure mode rather than "service is
 * absent".
 *
 * Setup:
 * 1. Pin web-api to a single replica so the CPU pressure concentrates
 *    on one process (otherwise rate is averaged across pods and won't
 *    cross threshold reliably).
 * 2. Scale load-200 way up — many curl pods hammering /, enough request
 *    volume to saturate the Go process's 200m CPU limit.
 * 3. `process_cpu_seconds_total{app="web-api"}` is auto-exposed by the Go
 *    runtime metrics in prometheus-example-app, so no fixture changes
 *    are needed. Threshold 0.05 cores/sec is comfortably above idle
 *    baseline (~0.005) and below the 0.2 limit ceiling.
 *
 * Assertion: rule fires, dispatcher links an investigationId onto the
 * rule, and the investigation reaches `completed` within the budget.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { apiPost, apiGet, apiDelete } from '../helpers/api-client.js';
import { pollUntil } from '../helpers/wait.js';
import { scaleDeployment } from '../helpers/scale.js';

const NS = 'openobs-e2e';
const TARGET = 'web-api';
const LOAD = 'load-200';
const BASELINE_TARGET_REPLICAS = 3;
const BASELINE_LOAD_REPLICAS = 1;
const SATURATING_LOAD_REPLICAS = 30;

interface AlertRule {
  id: string;
  state: 'normal' | 'pending' | 'firing' | 'resolved' | 'disabled';
  investigationId?: string;
}
interface Investigation {
  id: string;
  status: 'planning' | 'investigating' | 'evidencing' | 'explaining' | 'acting' | 'verifying' | 'completed' | 'failed';
}

describe.skipIf(!process.env['OPENOBS_TEST_LLM_API_KEY'])('cpu-saturated investigation', () => {
  let ruleId: string | null = null;

  beforeAll(async () => {
    // Concentrate load on one pod so per-process CPU rate crosses threshold.
    await scaleDeployment(NS, TARGET, 1);
    await scaleDeployment(NS, LOAD, BASELINE_LOAD_REPLICAS);
  }, 180_000);

  afterAll(async () => {
    if (ruleId) {
      try { await apiDelete(`/api/alert-rules/${ruleId}`); } catch { /* noop */ }
    }
    // Best-effort restore. Either step failing must not mask test failure.
    try { await scaleDeployment(NS, LOAD, BASELINE_LOAD_REPLICAS); } catch { /* noop */ }
    try { await scaleDeployment(NS, TARGET, BASELINE_TARGET_REPLICAS); } catch { /* noop */ }
  }, 180_000);

  it('CPU-saturation alert drives investigation to completion', async () => {
    // Spell out the PromQL explicitly so the alert generator preserves it
    // verbatim instead of inventing a different expression. Threshold 0.05
    // = 50m CPU sustained for 30s on a single pod under heavy load.
    const prompt =
      'create alert web-api-cpu-saturated: ' +
      'PromQL rate(process_cpu_seconds_total{app="web-api"}[1m]) > 0.05 ' +
      'for 30s severity high';
    const created = await apiPost<AlertRule>('/api/alert-rules/generate', { prompt });
    expect(created.id).toBeTruthy();
    ruleId = created.id;

    // Fan load-200 out — each curl pod sustains ~5 RPS hitting the single
    // web-api pod, driving its Go runtime + http handler past the 50m
    // threshold within one or two scrape cycles.
    await scaleDeployment(NS, LOAD, SATURATING_LOAD_REPLICAS);

    // Fire budget: ~5s scrape + 30s `for` + jitter under load = 60-120s.
    // Generous 180s buffer handles slow rollouts on resource-tight CI nodes.
    const fired = await pollUntil<AlertRule>(
      async () => {
        const rule = await apiGet<AlertRule>(`/api/alert-rules/${ruleId}`);
        return rule.state === 'firing' ? rule : null;
      },
      { timeoutMs: 180_000, intervalMs: 3000, label: 'cpu rule -> firing' },
    );
    expect(fired.state).toBe('firing');

    // Dispatcher links investigationId onto the rule on the firing transition.
    const linked = await pollUntil<AlertRule>(
      async () => {
        const rule = await apiGet<AlertRule>(`/api/alert-rules/${ruleId}`);
        return rule.investigationId ? rule : null;
      },
      { timeoutMs: 60_000, intervalMs: 2000, label: 'rule.investigationId set' },
    );
    expect(linked.investigationId).toBeTruthy();

    // Investigation reaches `completed`. CPU-saturation flow tends to do
    // more queries than the scale-to-0 case (the rate isn't 0, so the
    // agent has actual data to chase), so use the same 180s budget.
    const inv = await pollUntil<Investigation>(
      async () => {
        const i = await apiGet<Investigation>(`/api/investigations/${linked.investigationId}`);
        return i.status === 'completed' ? i : null;
      },
      { timeoutMs: 180_000, intervalMs: 3000, label: 'investigation -> completed' },
    );
    expect(inv.status).toBe('completed');
  }, 480_000);
});
