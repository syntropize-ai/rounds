/**
 * Prometheus metrics registry for the Agentic Observability Platform.
 *
 * All custom metrics are defined here as module-level singletons so they can be
 * imported and incremented from any module (investigation routes, LLM gateway
 * wrappers, adapter calls, proactive pipeline, etc.).
 */
import { Registry, collectDefaultMetrics, Counter, Histogram, Gauge } from 'prom-client';
// Dedicated registry avoids polluting the prom-client global default registry
// which can cause conflicts when tests import this module multiple times.
export const registry = new Registry();
// Default Node.js metrics (GC, event loop, memory, etc.)
collectDefaultMetrics({ register: registry });
// -- Investigations --
export const investigationsTotal = new Counter({
    name: 'agentic_obs_investigations_total',
    help: 'Total number of investigations started',
    labelNames: ['status'],
    registers: [registry],
});
export const investigationDuration = new Histogram({
    name: 'agentic_obs_investigation_duration_seconds',
    help: 'Duration of investigation runs in seconds',
    buckets: [1, 5, 10, 30, 60],
    registers: [registry],
});
// -- LLM calls --
export const llmCallsTotal = new Counter({
    name: 'agentic_obs_llm_calls_total',
    help: 'Total number of LLM API calls',
    labelNames: ['provider', 'model', 'status'],
    registers: [registry],
});
export const llmLatency = new Histogram({
    name: 'agentic_obs_llm_latency_seconds',
    help: 'Latency of LLM API calls in seconds',
    buckets: [0.1, 0.5, 1, 2, 5, 10, 30],
    registers: [registry],
});
export const llmTokensTotal = new Counter({
    name: 'agentic_obs_llm_tokens_total',
    help: 'Total number of LLM tokens consumed',
    labelNames: ['provider', 'type'],
    registers: [registry],
});
// -- Adapter calls --
export const adapterCallsTotal = new Counter({
    name: 'agentic_obs_adapter_calls_total',
    help: 'Total number of adapter calls (execution, data, notification)',
    labelNames: ['adapter', 'status'],
    registers: [registry],
});
// -- Proactive pipeline findings --
export const proactiveFindingsTotal = new Counter({
    name: 'agentic_obs_proactive_findings_total',
    help: 'Total number of findings raised by the proactive pipeline',
    labelNames: ['type'],
    registers: [registry],
});
// -- Incidents --
export const incidentsTotal = new Counter({
    name: 'agentic_obs_incidents_total',
    help: 'Total number of incidents created',
    labelNames: ['severity'],
    registers: [registry],
});
// -- Approvals --
export const approvalsPending = new Gauge({
    name: 'agentic_obs_approvals_pending',
    help: 'Number of execution approvals currently awaiting human review',
    registers: [registry],
});
// -- Queue depth --
export const queueDepth = new Gauge({
    name: 'agentic_obs_queue_depth',
    help: 'Current depth of async task queues',
    labelNames: ['queue'],
    registers: [registry],
});
//# sourceMappingURL=metrics.js.map
