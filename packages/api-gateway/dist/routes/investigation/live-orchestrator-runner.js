// LiveOrchestratorRunner - real LLM-powered investigation pipeline
// 1. LLM plans investigation steps (what metrics to check and why)
// 2. Executes each step: queries Prometheus for time-series data
// 3. LLM analyzes all collected evidence and produces conclusion
// 4. Evidence includes raw time-series data so the frontend can render charts.
import { randomUUID } from 'node:crypto';
import { AnthropicProvider, LLMGateway } from '@agentic-obs/llm-gateways';
import { PrometheusClient } from '@agentic-obs/adapters';
import { getSetupConfig } from '../setup.js';

export class LiveOrchestratorRunner {
  store;
  feed;

  constructor(store, feed) {
    this.store = store;
    this.feed = feed;
  }

  run(input) {
    void this.execute(input);
  }

  async execute(input) {
    const { investigationId, question } = input;
    try {
      const config = getSetupConfig();
      if (!config.llm) {
        throw new Error('LLM not configured - please complete the Setup Wizard first.');
      }
      const gateway = this.createGateway(config.llm);
      const model = config.llm.model || 'claude-sonnet-4-5';
      const promDatasources = config.datasources.filter((d) => d.type === 'prometheus');
      await this.store.updateStatus(investigationId, 'planning');
      const steps = await this.planInvestigation(gateway, model, question, promDatasources);
      await this.store.updatePlan(investigationId, {
        objective: question,
        entity: undefined,
        steps: steps.map((s) => ({
          id: s.id,
          type: 'metric_query',
          description: s.description,
          status: 'pending',
        })),
        stopConditions: [],
      });
      await this.store.updateStatus(investigationId, 'investigating');
      const allEvidence = [];
      const completedSteps = [];
      for (const step of steps) {
        const stepStart = Date.now();
        const stepRecord = {
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
        }
        catch (err) {
          stepRecord.status = 'failed';
          stepRecord.result = { error: err instanceof Error ? err.message : String(err) };
          stepRecord.cost = { tokens: 0, queries: 0, latencyMs: Date.now() - stepStart };
        }
        completedSteps.push(stepRecord);
        await this.store.updatePlan(investigationId, {
          objective: question,
          steps: completedSteps.concat(steps.slice(completedSteps.length).map((s) => ({
            id: s.id,
            type: 'metric_query',
            description: s.description,
            status: 'pending',
          }))),
          stopConditions: [],
        });
      }
      await this.store.updateStatus(investigationId, 'explaining');
      const { conclusion, hypotheses } = await this.analyzeEvidence(gateway, model, question, allEvidence);
      const linkedEvidence = allEvidence.map((ev) => ({ ...ev, hypothesisId: hypotheses[0]?.id ?? ev.hypothesisId }));
      await this.store.updateResult(investigationId, {
        hypotheses,
        evidence: linkedEvidence,
        conclusion,
      });
      await this.store.updateStatus(investigationId, 'complete');
      await this.feed.add('investigation_complete', question.length > 60 ? `${question.slice(0, 57)}...` : question, conclusion.summary, 'medium', investigationId);
    }
    catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      console.error(`[LiveOrchestratorRunner] Investigation ${input.investigationId} failed:`, errorMsg);
      const conclusion = {
        summary: 'Investigation failed. See error message.',
        rootCause: null,
        confidence: 0,
        recommendedActions: ['Check LLM configuration in Settings', 'Verify datasource connectivity'],
      };
      try {
        await this.store.updateResult(input.investigationId, { hypotheses: [], evidence: [], conclusion });
      }
      catch {
      }
      await this.store.updateStatus(input.investigationId, 'failed');
    }
  }

  async planInvestigation(gateway, model, question, datasources) {
    const hasPrometheus = datasources.length > 0;
    const messages = [
      {
        role: 'system',
        content: `You are a senior SRE planning a systematic investigation for a Kubernetes cluster.
${hasPrometheus ? 'The cluster has Prometheus monitoring. You can query it with PromQL.' : 'No metrics datasource is available.'}

Your job: plan 3-5 investigation steps. Each step checks one aspect of the problem.
For example, if the user reports "API server latency is high", you should plan steps like:
1. Check actual API server request latency (P50/P99/P90 by verb)
2. Check API server request rate / QPS
3. Check etcd latency (backend storage affects API server)
4. Check node resource usage (CPU/memory saturation)
5. Check active watchers / inflight requests

For each step, provide 1-4 promQL queries that gather the relevant data.
Use range queries with [5m] or [15m] window for rates.

Common K8s metrics:
- apiserver_request_duration_seconds_bucket/count/sum (by verb, resource, code)
- apiserver_current_inflight_requests (by request kind)
- etcd_request_duration_seconds_bucket/sum/count
- etcd_disk_backend_commit_duration_seconds_bucket
- container_cpu_usage_seconds_total, container_memory_working_set_bytes
- node_cpu_seconds_total, node_memory_MemAvailable_bytes
- kubelet_running_pods, kube_pod_status_phase
- up, process_cpu_seconds_total, process_resident_memory_bytes
- workqueue_depth, workqueue_adds_total

Respond with a JSON array:
[
  {
    "description": "Check API server request latency by verb",
    "rationale": "Direct measurement of the reported problem",
    "queries": [{ "promql": "histogram_quantile(...)", "description": "P99 latency" }]
  }
]
Only return the JSON array, nothing else.`,
      },
      { role: 'user', content: question },
    ];
    try {
      const resp = await gateway.complete(messages, { model, maxTokens: 2048, temperature: 0 });
      const cleaned = resp.content.replace(/```json\n?/g, '').replace(/```/g, '').trim();
      const raw = JSON.parse(cleaned);
      return raw.map((step) => ({
        id: randomUUID(),
        description: step.description,
        rationale: step.rationale,
        queries: step.queries,
      }));
    }
    catch (err) {
      console.warn('[LiveOrchestratorRunner] Planning failed, using defaults:', err instanceof Error ? err.message : err);
      return [
        {
          id: randomUUID(),
          description: 'Cluster overview',
          rationale: 'Basic health check',
          queries: [
            { promql: 'up', description: 'Target health' },
            { promql: 'node_cpu_seconds_total', description: 'CPU usage' },
          ],
        },
      ];
    }
  }

  async executeStep(step, datasources) {
    const evidence = [];
    for (const ds of datasources) {
      const client = new PrometheusClient({ baseUrl: ds.url });
      const end = new Date();
      const start = new Date(end.getTime() - 30 * 60 * 1000);
      for (const q of step.queries) {
        const evId = randomUUID();
        try {
          const rangeRes = await client.rangeQuery(q.promql, start, end, '30s');
          if (rangeRes.status === 'success') {
            const series = rangeRes.data.result.slice(0, 15).map((item) => ({
              labels: item.metric,
              points: item.values.map((entry) => ({ ts: entry[0] * 1000, value: parseFloat(entry[1]) })),
            }));
            const result = { query: q.promql, series, totalSeries: rangeRes.data.result.length };
            const summaryLines = series.slice(0, 5).map((s) => {
              const labelList = Object.entries(s.labels).filter(([k]) => k !== '__name__').slice(0, 3).map(([k, v]) => `${k}=${v}`).join(', ');
              const lastVal = s.points[s.points.length - 1]?.value ?? 0;
              const avg = s.points.length ? s.points.reduce((p, x) => p + x.value, 0) / s.points.length : 0;
              return `${labelList} last=${fmtNum(lastVal)} avg=${fmtNum(avg)}`;
            });
            evidence.push({
              id: evId,
              hypothesisId: '',
              type: 'metric',
              query: q.promql,
              queryLanguage: 'promql',
              result,
              summary: `${q.description}: ${rangeRes.data.result.length} series.\n${summaryLines.join('\n')}`,
              timestamp: new Date().toISOString(),
              reproducible: true,
            });
          }
        }
        catch (err) {
          try {
            const instantRes = await client.instantQuery(q.promql);
            if (instantRes.status === 'success') {
              const series = instantRes.data.result.slice(0, 15).map((item) => ({
                labels: item.metric,
                points: [{ ts: Date.now(), value: parseFloat(item.value[1]) }],
              }));
              const result = { query: q.promql, series, totalSeries: instantRes.data.result.length };
              const summaryLines = series.slice(0, 5).map((s) => {
                const labelList = Object.entries(s.labels).filter(([k]) => k !== '__name__').slice(0, 3).map(([k, v]) => `${k}=${v}`).join(', ');
                return `${labelList} ${fmtNum(s.points[0]?.value ?? 0)}`;
              });
              evidence.push({
                id: evId,
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
          }
          catch (innerErr) {
            evidence.push({
              id: evId,
              hypothesisId: '',
              type: 'metric',
              query: q.promql,
              queryLanguage: 'promql',
              result: { query: q.promql, series: [], totalSeries: 0 },
              summary: `${q.description}: query failed - ${innerErr instanceof Error ? innerErr.message : String(innerErr)}`,
              timestamp: new Date().toISOString(),
              reproducible: false,
            });
          }
        }
      }
    }
    return evidence;
  }

  async analyzeEvidence(gateway, model, question, evidence) {
    const evidenceSummary = evidence.map((ev, i) => `Evidence ${i + 1}: ${ev.summary}`).join('\n\n');
    const messages = [
      {
        role: 'system',
        content: `You are a senior SRE analyzing investigation evidence from a Kubernetes cluster.
You have been given metric data collected from Prometheus. Your job:
1. Look at the ACTUAL DATA, not assumptions
2. If values are normal/expected, SAY SO - don't invent problems that don't exist
3. Distinguish between "this metric looks alarming but is actually expected behavior" vs "this is a real anomaly"
4. Consider whether the user's reported problem is real or a misunderstanding

Avoid generic report text!
- Watch request durations or 30-40s are NORMAL - WATCH is a long-polling mechanism
- Low CPU/low usage on subset/cluster usually means the cluster is okay
- If there are few pods and low QPS, the cluster is likely healthy

Respond with a JSON object:
{
  "summary": "3-5 sentences analysis referencing actual metric values from the evidence",
  "rootCause": "specific root cause, or null if there is no actual problem",
  "confidence": 0.0 to 1.0,
  "recommendedActions": ["specific, actionable step"],
  "hypotheses": [
    {
      "description": "What you think is happening",
      "confidence": 0.0 to 1.0,
      "status": "supported, or refuted, or inconclusive"
    }
  ]
}

Be honest. If the data shows nothing is wrong, say so clearly. Don't over-diagnose.
Only return the JSON object.`,
      },
      {
        role: 'user',
        content: `User's question: ${question}\n\nCollected evidence:\n${evidenceSummary}`,
      },
    ];
    try {
      const resp = await gateway.complete(messages, { model, maxTokens: 2048, temperature: 0.1 });
      const cleaned = resp.content.replace(/```json\n?/g, '').replace(/```/g, '').trim();
      const parsed = JSON.parse(cleaned);
      const hypotheses = (parsed.hypotheses ?? []).map((h) => ({
        id: randomUUID(),
        investigationId: '',
        description: h.description,
        confidence: h.confidence,
        evidenceBasis: `Based on ${evidence.length} metric evidence items`,
        status: h.status || 'proposed',
        evidenceIds: [],
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
    }
    catch {
      return {
        conclusion: {
          summary: evidence.length ? evidence[0].summary.slice(0, 500) : 'Analysis complete.',
          rootCause: null,
          confidence: 0.3,
          recommendedActions: [],
        },
        hypotheses: [],
      };
    }
  }

  createGateway(llmConfig) {
    const isCorporateGateway = llmConfig.provider === 'corporate-gateway' || !!llmConfig.tokenHelperCommand;
    const provider = new AnthropicProvider({
      apiKey: llmConfig.apiKey,
      baseURL: llmConfig.baseURL,
      authType: isCorporateGateway ? (llmConfig.authType ?? 'bearer') : (llmConfig.authType ?? 'api-key'),
      tokenHelperCommand: llmConfig.tokenHelperCommand,
    });
    return new LLMGateway({ primary: provider, maxRetries: 2 });
  }
}

function fmtNum(n) {
  if (Number.isNaN(n)) {
    return '0';
  }
  if (Math.abs(n) >= 1e9)
    return `${(n / 1e9).toFixed(2)}G`;
  if (Math.abs(n) >= 1e6)
    return `${(n / 1e6).toFixed(2)}M`;
  if (Math.abs(n) >= 1e3)
    return `${(n / 1e3).toFixed(2)}K`;
  return n.toFixed(Math.abs(n) < 1 ? 4 : 2);
}
//# sourceMappingURL=live-orchestrator-runner.js.map
