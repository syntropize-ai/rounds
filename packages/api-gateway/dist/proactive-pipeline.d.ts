/**
 * Proactive Pipeline Bootstrap
 *
 * Wires together the four proactive monitoring components:
 * AnomalyDetector -> CorrelationEngine -> IncidentStore -> FeedStore
 * SloBurnMonitor -> CorrelationEngine -> IncidentStore -> FeedStore
 * ChangeWatcher -> CorrelationEngine -> IncidentStore -> FeedStore
 *
 * Also provides a TopologyStoreAdapter that bridges the data-layer
 * TopologyStore to the CorrelationEngine's TopologyProvider interface.
 *
 * Usage (in startServer):
 *   const pipeline = createProactivePipeline({ feed: feedStore, incidents: incidentStore });
 *   pipeline.start();
 */
import type { AnomalyDetector, SloBurnMonitor, ChangeWatcher, CorrelationEngine, TopologyProvider, AlertRuleEvaluator } from '@agentic-obs/agent-core';
import type { TopologyStore } from '@agentic-obs/data-layer';
import type { FeedStore } from './routes/feed-store.js';
import type { IncidentStore } from './routes/incident-store.js';
/**
 * Bridges the data-layer TopologyStore to the CorrelationEngine's
 * TopologyProvider interface, returning all direct upstream and downstream
 * neighbour IDs for a given serviceId.
 */
export declare class TopologyStoreAdapter implements TopologyProvider {
    private readonly store;
    constructor(store: TopologyStore);
    getRelatedServices(serviceId: string): string[];
}
export interface ProactivePipelineDeps {
    feed: FeedStore;
    incidents: IncidentStore;
}
export interface ProactivePipelineComponents {
    anomalyDetector?: AnomalyDetector;
    sloBurnMonitor?: SloBurnMonitor;
    changeWatcher?: ChangeWatcher;
    correlationEngine: CorrelationEngine;
    alertRuleEvaluator?: AlertRuleEvaluator;
}
export interface ProactivePipeline {
    start(): void;
    stop(): void;
}
/**
 * Wire the proactive components together and return a handle to start/stop
 * the whole pipeline.
 *
 * All wiring is set up synchronously; call `start()` to begin polling.
 */
export declare function createProactivePipeline(components: ProactivePipelineComponents, deps: ProactivePipelineDeps): ProactivePipeline;
//# sourceMappingURL=proactive-pipeline.d.ts.map