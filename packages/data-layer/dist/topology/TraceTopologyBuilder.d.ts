import { TopologyStore } from './TopologyStore.js';
import type { TopologyEdge } from './types.js';
export interface SpanRef {
    spanId: string;
    parentSpanId: string;
    service: string;
}
export interface TraceRef {
    traceId: string;
    spans: SpanRef[];
}
export interface TraceProvider {
    /** Fetch recent traces for topology derivation. */
    getTraces(): Promise<TraceRef[]>;
}
export interface IngestResult {
    nodesAdded: number;
    edgesAdded: number;
    tracesProcessed: number;
}
export interface TraceTopologyBuilderConfig {
    /** How often to refresh topology in ms. Used by start(). Default: 60,000 */
    refreshIntervalMs?: number;
}
export declare class TraceTopologyBuilder {
    private readonly store;
    private readonly config;
    private timer;
    constructor(store: TopologyStore, config?: TraceTopologyBuilderConfig);
    /**
     * Add a manually-curated edge between two services.
     * Manual edges are never overwritten by automatic discovery.
     * Ensures both service nodes exist (creating stubs if needed).
     */
    addManualEdge(sourceServiceId: string, targetServiceId: string, metadata?: Record<string, string>): TopologyEdge;
    /**
     * Process a batch of traces and update the topology store.
     *  - Adds service nodes for every service seen.
     *  - Adds "calls" edges for cross-service parent-child span relationships.
     *  - Skips the edge if a manual edge for the same source-target already exists.
     */
    ingestTraces(traces: TraceRef[]): IngestResult;
    /**
     * Start periodic topology refresh using the provided TraceProvider.
     * Runs an immediate pass then polls on the configured interval.
     */
    start(provider: TraceProvider): void;
    /** Stop periodic refresh. */
    stop(): void;
    /** Run a single refresh cycle: fetch traces and ingest them. */
    refresh(provider: TraceProvider): Promise<IngestResult>;
    private ensureServiceNode;
    private hasManualEdge;
    private hasAutoEdge;
}
//# sourceMappingURL=TraceTopologyBuilder.d.ts.map