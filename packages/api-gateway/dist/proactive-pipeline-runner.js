/**
 * Proactive pipeline runner - instantiates the CorrelationEngine with the
 * shared store singletons and starts monitoring.
 *
 * When REDIS_URL is set, proactive findings are enqueued via BullMQ so that
 * a separate worker process can process them independently. When REDIS_URL is
 * absent the InMemoryWorkerQueue is used, dispatching jobs in-process.
 *
 * This module is imported lazily by startServer() so it does not run during
 * tests (which only call createApp()).
 */
import { CorrelationEngine, AlertRuleEvaluator } from '@agentic-obs/agent-core';
import { createWorkerQueueFromEnv } from '@agentic-obs/common';
import { feedStore } from './routes/feed-store.js';
import { incidentStore } from './routes/incident-store.js';
import { createProactivePipeline } from './proactive-pipeline.js';
import { setPipelineRunning } from './routes/health.js';
import { createLogger } from '@agentic-obs/common';
import { PrometheusPromQlEvaluator } from './routes/alert-promql-adapter.js';
import { AlertRuleStoreProvider } from './routes/alert-rule-provider-adapter.js';
import { defaultAlertRuleStore } from './routes/alert-rule-store.js';
import { getSetupConfig, ensureConfigLoaded } from './routes/setup.js';
const log = createLogger('proactive-pipeline-runner');
let started = false;
export async function runProactivePipeline() {
    if (started) {
        return;
    }
    started = true;
    // Wait for persisted config (LLM, datasources) to load from disk
    await ensureConfigLoaded();
    const queue = createWorkerQueueFromEnv();
    // Register job handlers
    queue.process('anomaly-check', async (job) => {
        log.debug({ serviceId: job.data.serviceId }, 'processing anomaly-check job');
    });
    queue.process('slo-check', async (job) => {
        log.debug({ sloId: job.data.sloId }, 'processing slo-check job');
    });
    queue.process('change-correlate', async (job) => {
        log.debug({ changeId: job.data.changeId }, 'processing change-correlate job');
    });
    queue.process('correlate', async (job) => {
        log.debug({ symptomCount: job.data.symptoms.length }, 'processing correlate job');
    });
    // Build pipeline and wire queue enqueue into callbacks
    const correlationEngine = new CorrelationEngine({
        correlationWindowMs: 30 * 60_000,
        checkIntervalMs: 60_000,
    });
    // -- AlertRuleEvaluator (optional - requires Prometheus datasource)
    const prometheusUrl = process.env['PROMETHEUS_URL'];
    const config = getSetupConfig();
    const promDs = config.datasources.find(d => d.type === 'prometheus' || d.type === 'victoria-metrics');
    const prometheusUri = prometheusUrl || promDs?.url;
    let alertRuleEvaluator;
    if (prometheusUri) {
        const headers = {};
        if (promDs?.username && promDs?.password) {
            headers['Authorization'] = `Basic ${Buffer.from(`${promDs.username}:${promDs.password}`).toString('base64')}`;
        }
        else if (promDs?.apiKey) {
            headers['Authorization'] = `Bearer ${promDs.apiKey}`;
        }
        const provider = new PrometheusPromQlEvaluator(prometheusUri, headers);
        const storeProvider = new AlertRuleStoreProvider(defaultAlertRuleStore);
        alertRuleEvaluator = new AlertRuleEvaluator(provider, storeProvider);
        log.info('AlertRuleEvaluator enabled (PROMETHEUS_URL)', prometheusUri);
    }
    const pipeline = createProactivePipeline({ correlationEngine, alertRuleEvaluator }, { feed: feedStore, incidents: incidentStore });
    // Override finding callbacks to also queue
    correlationEngine.onIncident((draft) => {
        queue.add('correlate', {
            symptoms: draft.symptoms,
            changes: draft.changes,
        }, {
            attempts: 3,
            backoff: { type: 'exponential', delay: 1000 },
        });
    });
    pipeline.start();
    setPipelineRunning(true);
    log.info(`proactive pipeline started (queue backend: ${process.env['REDIS_URL'] ? 'bullmq' : 'memory'})`);
}
//# sourceMappingURL=proactive-pipeline-runner.js.map
