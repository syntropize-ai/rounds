/**
 * Proactive pipeline runner - instantiates the CorrelationEngine with the
 * shared store singletons and starts monitoring.
 *
 * When REDIS_URL is set, proactive findings are enqueued via BullMQ so that
 * a separate worker process can process them independently. When REDIS_URL is
 * absent the in-memory/workerQueue is used, dispatching jobs in-process.
 *
 * This module is imported lazily by startServer() so it does not run during
 * tests (which only call createApp()).
 */
export declare function runProactivePipeline(): Promise<void>;
//# sourceMappingURL=proactive-pipeline-runner.d.ts.map