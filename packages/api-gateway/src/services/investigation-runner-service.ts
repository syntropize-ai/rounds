import { randomUUID } from 'node:crypto';

import { createLogger } from '@agentic-obs/common';
import type { Evidence, Hypothesis, InvestigationStep } from '@agentic-obs/common';

const log = createLogger('investigation-runner');
import type { ExplanationResult } from '@agentic-obs/agent-core';
import type { CompletionMessage, LLMGateway } from '@agentic-obs/llm-gateway';
import { PrometheusHttpClient } from '@agentic-obs/adapters';

import { getSetupConfig } from '../routes/setup.js';
import type { DatasourceConfig } from '../routes/setup.js';
import { createLlmGateway } from '../routes/llm-factory.js';
import type { IGatewayInvestigationStore, IGatewayFeedStore } from '../repositories/types.js';
import type { OrchestratorRunner, OrchestratorRunInput } from '../routes/investigation/orchestrator-runner.js';

interface TimeSeriesPoint {
  ts: number;
  value: number;
}

interface TimeSeriesData {
  labels: Record<string, string>;
  points: TimeSeriesPoint[];
}

interface MetricEvidenceResult {
  query: string;
  series: TimeSeriesData[];
  totalSeries: number;
}

interface PlannedStep {
  id: string;
  description: string;
  rationale: string;
  queries: Array<{ promql: string; description: string }>;
}

export class LiveOrchestratorRunner implements OrchestratorRunner {
  constructor(
    private readonly store: IGatewayInvestigationStore,
    private readonly feed: IGatewayFeedStore,
  ) {}

  run(input: OrchestratorRunInput): void {
    void this.execute(input);
  }

  private async execute(input: OrchestratorRunInput): Promise<void> {
    const { investigationId, question } = input;

    try {
      const config = getSetupConfig();
      if (!config.llm) {
        throw new Error('LLM not configured - please complete the Setup Wizard first.');
      }

      const gateway = this.createGateway(config.llm);
      const model = config.llm.model;
      const promDatasources = config.datasources.filter((d) => d.type === 'prometheus' || d.type === 'victoria-metrics');

      await this.store.updateStatus(investigationId, 'planning');
      const steps = await this.planInvestigation(gateway, model, question, promDatasources);

      await this.store.updatePlan(investigationId, {
        entity: '',
        objective: question,
        steps: steps.map((s) => ({
          id: s.id,
          type: 'metric_query',
          description: s.description,
          status: 'pending' as const,
        })),
        stopConditions: [],
      });

      await this.store.updateStatus(investigationId, 'investigating');

      const allEvidence: Evidence[] = [];
      const completedSteps: InvestigationStep[] = [];

      for (const step of steps) {
        const stepStart = Date.now();
        const stepRecord: InvestigationStep = {
          id: step.id,
          type: 'metric_query',
          description: step.description,
          status: 'running',
        };

        try {
          const evidenceItems = await this.executeStep(step, promDatasources);
          allEvidence.push(...evidenceItems);
          stepRecord.status = 'completed';
          stepRecord.result = { evidenceCount: evidenceItems.length };
          stepRecord.cost = { tokens: 0, queries: step.queries.length, latencyMs: Date.now() - stepStart };
        } catch (err) {
          stepRecord.status = 'failed';
          stepRecord.result = { error: err instanceof Error ? err.message : String(err) };
          stepRecord.cost = { tokens: 0, queries: 0, latencyMs: Date.now() - stepStart };
        }

        completedSteps.push(stepRecord);

        await this.store.updatePlan(investigationId, {
          entity: '',
          objective: question,
          steps: completedSteps.concat(
            steps.slice(completedSteps.length).map((s) => ({
              id: s.id,
              type: 'metric_query',
              description: s.description,
              status: 'pending' as const,
            })),
          ),
          stopConditions: [],
        });
      }

      await this.store.updateStatus(investigationId, 'explaining');

      const { conclusion, hypotheses } = await this.analyzeEvidence(
        gateway,
        model,
        question,
        allEvidence,
        investigationId,
      );

      const linkedEvidence = allEvidence.map((ev) => ({
        ...ev,
        hypothesisId: hypotheses[0]?.id ?? ev.hypothesisId,
      }));

      await this.store.updateResult(investigationId, {
        hypotheses,
        evidence: linkedEvidence,
        conclusion,
      });

      await this.store.updateStatus(investigationId, 'completed');
      await this.feed.add(
        'investigation_complete',
        question.length > 50 ? `${question.slice(0, 57)}...` : question,
        conclusion.summary,
        conclusion.confidence >= 0.7 ? 'medium' : 'low',
        investigationId,
      );
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      log.error({ investigationId, error: errorMsg }, 'investigation failed');

      const conclusion: ExplanationResult = {
        summary: `Investigation failed: ${errorMsg}`,
        rootCause: null,
        confidence: 0,
        recommendedActions: ['Check LLM configuration in Settings', 'Verify datasource connectivity'],
      };

      try {
        await this.store.updateResult(investigationId, { hypotheses: [], evidence: [], conclusion });
      } catch {}

      await this.store.updateStatus(investigationId, 'failed');
    }
  }

  private async planInvestigation(
    gateway: LLMGateway,
    model: string,
    question: string,
    datasources: DatasourceConfig[],
  ): Promise<PlannedStep[]> {
    const hasPrometheus = datasources.length > 0;
    const messages: CompletionMessage[] = [
      {
        role: 'system',
        content:
          `You are a senior SRE planning a systematic investigation for a Kubernetes cluster.\n` +
          `${hasPrometheus ? 'The cluster has Prometheus monitoring. You can query it with PromQL.' : 'No metrics datasource is available.'}\n\n` +
          `Your job: plan 3-6 investigation steps. Each step checks one aspect of the problem.\n` +
          `For example, if the user reports "API server latency is high", you should plan steps like:\n` +
          `1. Check actual API server request latency (P50/P90/P99 by verb)\n` +
          `2. Check API server request rate / QPS\n` +
          `3. Check etcd latency (backend storage affects API server)\n` +
          `4. Check node resource usage (CPU/memory saturation)\n` +
          `5. Check active watchers / inflight requests\n\n` +
          `For each step, provide 1-3 PromQL queries that gather the relevant data.\n` +
          `Use range queries with [5m] or [15m] windows for rates.\n\n` +
          `IMPORTANT: include queries that can DISPROVE the user's assumption too. If the data shows everything is normal, that's a valid finding.\n\n` +
          `Common k8s metrics:\n` +
          `- apiserver_request_duration_seconds_bucket/sum/count (by verb, resource, code)\n` +
          `- apiserver_current_inflight_requests (by request_kind)\n` +
          `- apiserver_request_total (by verb, code, resource)\n` +
          `- etcd_request_duration_seconds_bucket/sum/count\n` +
          `- container_cpu_usage_seconds_total, container_memory_working_set_bytes\n` +
          `- node_cpu_seconds_total, node_memory_MemAvailable_bytes\n` +
          `- kubelet_running_pods, kube_pod_status_phase\n` +
          `- workqueue_depth, workqueue_adds_total\n\n` +
          `Respond with a JSON array:\n` +
          `[\n` +
          `  {\n` +
          `    "description": "Check API server request latency by verb",\n` +
          `    "rationale": "Direct measurement of the reported problem",\n` +
          `    "queries": [\n` +
          `      { "promql": "histogram_quantile(0.99, rate(apiserver_request_duration_seconds_bucket[5m]))", "description": "P99 latency" }\n` +
          `    ]\n` +
          `  }\n` +
          `]\n\n` +
          `Only return the JSON array, nothing else.`,
      },
      { role: 'user', content: question },
    ];

    try {
      const resp = await gateway.complete(messages, { model, maxTokens: 2048, temperature: 0 });
      const cleaned = resp.content.replace(/```json\n?/g, '').replace(/```/g, '').trim();
      const raw = JSON.parse(cleaned) as Array<{
        description: string;
        rationale: string;
        queries: Array<{ promql: string; description: string }>;
      }>;

      return raw.map((step) => ({
        id: randomUUID(),
        description: step.description,
        rationale: step.rationale,
        queries: step.queries,
      }));
    } catch (err) {
      log.warn({ err }, 'planning failed, using defaults');

      return [
        {
          id: randomUUID(),
          description: 'Cluster overview',
          rationale: 'Basic health check',
          queries: [
            { promql: 'up', description: 'Target health' },
            { promql: 'kube_pod_status_phase', description: 'Pod phases' },
          ],
        },
      ];
    }
  }

  private async executeStep(
    step: PlannedStep,
    datasources: DatasourceConfig[],
  ): Promise<Evidence[]> {
    const evidence: Evidence[] = [];

    for (const ds of datasources) {
      const client = new PrometheusHttpClient({ baseUrl: ds.url });
      const end = new Date();
      const start = new Date(end.getTime() - 60 * 60 * 1000);

      for (const q of step.queries) {
        const evid = randomUUID();

        try {
          const rangeRes = await client.rangeQuery(q.promql, start, end, '30s');

          if (rangeRes.status === 'success') {
            const series: TimeSeriesData[] = rangeRes.data.result.slice(0, 15).map((item: any) => ({
              labels: item.metric,
              points: item.values.map(([ts, val]: [number, string]) => ({
                ts: ts * 1000,
                value: parseFloat(val),
              })),
            }));

            const result: MetricEvidenceResult = {
              query: q.promql,
              series,
              totalSeries: rangeRes.data.result.length,
            };

            const summaryLines = series.slice(0, 5).map((s) => {
              const labelStr = Object.entries(s.labels)
                .filter(([k]) => k !== '__name__')
                .slice(0, 3)
                .map(([k, v]) => `${k}=${v}`)
                .join(',');
              const lastValue = s.points[s.points.length - 1]?.value ?? 0;
              const avg = s.points.length > 0
                ? s.points.reduce((p, v) => p + v.value, 0) / s.points.length
                : 0;
              return `${labelStr} latest=${fmtNum(lastValue)} avg=${fmtNum(avg)}`;
            });

            const summary = `${q.description}: ${rangeRes.data.result.length} series.\n${summaryLines.join('\n')}`;

            evidence.push({
              id: evid,
              hypothesisId: '',
              type: 'metric',
              query: q.promql,
              queryLanguage: 'promql',
              result,
              summary,
              timestamp: new Date().toISOString(),
              reproducible: true,
            });
          }
        } catch (err) {
          try {
            const instantRes = await client.instantQuery(q.promql);

            if (instantRes.status === 'success') {
              const series: TimeSeriesData[] = instantRes.data.result.slice(0, 15).map((item: any) => ({
                labels: item.metric,
                points: [{ ts: item.value[0] * 1000, value: parseFloat(item.value[1]) }],
              }));

              const result: MetricEvidenceResult = {
                query: q.promql,
                series,
                totalSeries: instantRes.data.result.length,
              };

              const summaryLines = series.slice(0, 5).map((s) => {
                const labelStr = Object.entries(s.labels)
                  .filter(([k]) => k !== '__name__')
                  .slice(0, 3)
                  .map(([k, v]) => `${k}=${v}`)
                  .join(',');
                return `${labelStr} ${fmtNum(s.points[0]?.value ?? 0)}`;
              });

              evidence.push({
                id: evid,
                hypothesisId: '',
                type: 'metric',
                query: q.promql,
                queryLanguage: 'promql',
                result,
                summary: `${q.description}: ${instantRes.data.result.length} series.\n${summaryLines.join('\n')}`,
                timestamp: new Date().toISOString(),
                reproducible: true,
              });
            }
          } catch {
            evidence.push({
              id: evid,
              hypothesisId: '',
              type: 'metric',
              query: q.promql,
              queryLanguage: 'promql',
              result: { query: q.promql, series: [], totalSeries: 0 },
              summary: `${q.description}: query failed - ${err instanceof Error ? err.message : String(err)}`,
              timestamp: new Date().toISOString(),
              reproducible: false,
            });
          }
        }
      }
    }

    return evidence;
  }

  private async analyzeEvidence(
    gateway: LLMGateway,
    model: string,
    question: string,
    evidence: Evidence[],
    investigationId: string,
  ): Promise<{ conclusion: ExplanationResult; hypotheses: Hypothesis[] }> {
    const evidenceSummary = evidence
      .map((ev) => `- ${ev.summary}`)
      .join('\n');

    const messages: CompletionMessage[] = [
      {
        role: 'system',
        content:
          `You are a senior SRE analyzing investigation evidence from a Kubernetes cluster.\n\n` +
          `You have been given metric data collected from Prometheus. Your job:\n` +
          `1. Look at the ACTUAL DATA, not assumptions\n` +
          `2. If values are normal/expected, SAY SO - don't invent problems that don't exist\n` +
          `3. Distinguish between "this metric looks alarming but is actually expected behavior" vs "this is a real anomaly"\n` +
          `4. Consider whether the user's reported problem is real or a misunderstanding\n\n` +
          `For Kubernetes specifically:\n` +
          `- WATCH request durations or > 30s are NORMAL - WATCH is a long-polling mechanism\n` +
          `- Low CPU/memory usage and 0 rest/dev cluster is expected\n` +
          `- kube-controller-manager and kube-scheduler scrape failures in Kind are a known config issue, not a real problem\n` +
          `- If there are few pods and low QPS, the cluster is likely healthy\n\n` +
          `Respond with a JSON object:\n` +
          `{\n` +
          `  "summary": "2-4 sentence analysis referencing actual metric values from the evidence",\n` +
          `  "rootCause": "identified root cause, or null if there is no actual problem",\n` +
          `  "confidence": 0.0 to 1.0,\n` +
          `  "recommendedActions": ["specific, actionable next step"],\n` +
          `  "hypotheses": [\n` +
          `    {\n` +
          `      "description": "what you think is happening",\n` +
          `      "confidence": 0.0 to 1.0,\n` +
          `      "status": "supported" or "refuted" or "inconclusive"\n` +
          `    }\n` +
          `  ]\n` +
          `}\n\n` +
          `Be honest. If the data shows nothing is wrong, say so clearly. Don't over-diagnose.\n` +
          `Only return the JSON object.`,
      },
      {
        role: 'user',
        content: `User's question: ${question}\n\nCollected evidence:\n${evidenceSummary}`,
      },
    ];

    const resp = await gateway.complete(messages, { model, maxTokens: 2048, temperature: 0.1 });
    const cleaned = resp.content.replace(/```json\n?/g, '').replace(/```/g, '').trim();

    try {
      const parsed = JSON.parse(cleaned) as {
        summary: string;
        rootCause: string | null;
        confidence: number;
        recommendedActions?: string[];
        hypotheses?: Array<{
          description: string;
          confidence: number;
          status: string;
        }>;
      };

      const hypotheses: Hypothesis[] = (parsed.hypotheses ?? []).map((h) => ({
        id: randomUUID(),
        investigationId,
        description: h.description,
        confidence: h.confidence,
        confidenceBasis: `Based on ${evidence.length} metric evidence items`,
        status: h.status as Hypothesis['status'],
        evidenceIds: evidence.map((e) => e.id),
        counterEvidenceIds: [],
      }));

      return {
        conclusion: {
          summary: parsed.summary || 'Analysis complete.',
          rootCause: parsed.rootCause ?? null,
          confidence: typeof parsed.confidence === 'number' ? parsed.confidence : 0.5,
          recommendedActions: Array.isArray(parsed.recommendedActions) ? parsed.recommendedActions : [],
        },
        hypotheses,
      };
    } catch {
      return {
        conclusion: {
          summary: resp.content.slice(0, 500),
          rootCause: null,
          confidence: 0.3,
          recommendedActions: [],
        },
        hypotheses: [],
      };
    }
  }

  private createGateway(llmConfig: Parameters<typeof createLlmGateway>[0]) {
    return createLlmGateway(llmConfig);
  }
}

function fmtNum(n: number): string {
  if (Number.isNaN(n)) return 'NaN';
  if (Math.abs(n) >= 1e9) return `${(n / 1e9).toFixed(2)}G`;
  if (Math.abs(n) >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (Math.abs(n) >= 1e3) return `${(n / 1e3).toFixed(2)}K`;
  if (Math.abs(n) < 0.001 && n !== 0) return n.toExponential(2);
  return n.toFixed(Math.abs(n) < 1 ? 4 : 2);
}
