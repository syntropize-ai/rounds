// TraceTopologyBuilder - derives service call graph from distributed trace spans.
//
// Algorithm:
//   For every span that has a parentSpanId, locate the parent span.
//   If the parent and child belong to different services, record a directed
//   "calls" edge: parent.service -> child.service.
//
// Manual edges (edge.manual === true) are never overwritten or removed.
export class TraceTopologyBuilder {
    store;
    config;
    timer = null;
    constructor(store, config = {}) {
        this.store = store;
        this.config = {
            refreshIntervalMs: config.refreshIntervalMs ?? 60_000,
        };
    }
    // — Manual edge management
    /**
     * Add a manually-curated edge between two services.
     * Manual edges are never overwritten by automatic discovery.
     * Ensures both service nodes exist (creating stubs if needed).
     */
    addManualEdge(sourceServiceId, targetServiceId, metadata) {
        this.ensureServiceNode(sourceServiceId);
        this.ensureServiceNode(targetServiceId);
        return this.store.addEdge({
            type: 'calls',
            sourceId: sourceServiceId,
            targetId: targetServiceId,
            manual: true,
            metadata,
        });
    }
    // — Trace ingestion
    /**
     * Process a batch of traces and update the topology store.
     *  - Adds service nodes for every service seen.
     *  - Adds "calls" edges for cross-service parent-child span relationships.
     *  - Skips the edge if a manual edge for the same source-target already exists.
     */
    ingestTraces(traces) {
        let nodesAdded = 0;
        let edgesAdded = 0;
        // Collect unique service-to-service call pairs
        const callPairs = new Set(); // "sourceId::targetId"
        const servicesSeen = new Set();
        for (const trace of traces) {
            // Build spanId-service lookup for this trace
            const spanServices = new Map();
            for (const span of trace.spans) {
                spanServices.set(span.spanId, span.service);
                servicesSeen.add(span.service);
            }
            // Find cross-service calls
            for (const span of trace.spans) {
                if (!span.parentSpanId)
                    continue;
                const parentService = spanServices.get(span.parentSpanId);
                if (!parentService || parentService === span.service)
                    continue;
                callPairs.add(`${parentService}::${span.service}`);
            }
        }
        // Ensure nodes exist for all services
        for (const serviceId of servicesSeen) {
            if (!this.store.getNode(serviceId)) {
                this.store.addNode({
                    id: serviceId,
                    type: 'service',
                    name: serviceId,
                    metadata: { source: 'trace-discovery' },
                    tags: [],
                });
                nodesAdded++;
            }
        }
        // Add auto-discovered edges (skip if manual edge already covers same pair)
        for (const pair of callPairs) {
            const [sourceId, targetId] = pair.split('::');
            if (this.hasManualEdge(sourceId, targetId))
                continue;
            if (this.hasAutoEdge(sourceId, targetId))
                continue;
            this.store.addEdge({
                type: 'calls',
                sourceId,
                targetId,
                manual: false,
                metadata: { source: 'trace-discovery' },
            });
            edgesAdded++;
        }
        return { nodesAdded, edgesAdded, tracesProcessed: traces.length };
    }
    // — Periodic refresh
    /**
     * Start periodic topology refresh using the provided TraceProvider.
     * Runs an immediate pass then polls on the configured interval.
     */
    start(provider) {
        if (this.timer)
            return;
        void this.refresh(provider);
        this.timer = setInterval(() => void this.refresh(provider), this.config.refreshIntervalMs);
    }
    /** Stop periodic refresh. */
    stop() {
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = null;
        }
    }
    /** Run a single refresh cycle: fetch traces and ingest them. */
    async refresh(provider) {
        const traces = await provider.getTraces();
        return this.ingestTraces(traces);
    }
    // — Helpers
    ensureServiceNode(serviceId) {
        const existing = this.store.getNode(serviceId);
        if (existing)
            return existing;
        return this.store.addNode({
            id: serviceId,
            type: 'service',
            name: serviceId,
            metadata: { source: 'manual' },
            tags: [],
        });
    }
    hasManualEdge(sourceId, targetId) {
        return this.store
            .listEdges('calls')
            .some((e) => e.sourceId === sourceId && e.targetId === targetId && e.manual === true);
    }
    hasAutoEdge(sourceId, targetId) {
        return this.store
            .listEdges('calls')
            .some((e) => e.sourceId === sourceId && e.targetId === targetId && !e.manual);
    }
}
//# sourceMappingURL=TraceTopologyBuilder.js.map