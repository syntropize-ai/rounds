// Context Agent - assembles SystemContext from topology, changes, SLO, and incidents
const DEFAULT_LOOKBACK_MS = 24 * 60 * 60 * 1000; // 24h

export class ContextAgent {
    name = 'context';
    topology;
    changes;
    sloProvider;
    incidentProvider;
    changeLookbackMs;

    constructor(deps) {
        this.topology = deps.topologyStore;
        this.changes = deps.changeEventStore;
        this.sloProvider = deps.sloProvider;
        this.incidentProvider = deps.incidentProvider;
        this.changeLookbackMs = deps.changeLookbackMs ?? DEFAULT_LOOKBACK_MS;
    }

    async run(input, _context) {
        try {
            const ctx = await this.collect(input);
            return { success: true, data: ctx };
        }
        catch (err) {
            return {
                success: false,
                error: `ContextAgent failed: ${err instanceof Error ? err.message : String(err)}`,
            };
        }
    }

    // -- Collection logic --------------------------------------------------
    async collect(intent) {
        const entity = intent.entity;
        const collectedAt = new Date().toISOString();
        // Determine the time range for change/SLO lookback
        const rangeEnd = new Date(intent.timeRange.end);
        const rangeStart = new Date(Math.min(new Date(intent.timeRange.start).getTime(), rangeEnd.getTime() - this.changeLookbackMs));
        // Resolve entity to canonical service ID (fuzzy match if exact lookup fails)
        const canonicalId = this.resolveEntityId(entity);
        const [topologyCtx, recentChanges, sloStatus, historicalIncidents] = await Promise.all([
            this.collectTopology(entity, canonicalId),
            this.collectChanges(canonicalId, rangeStart, rangeEnd),
            this.collectSloStatus(entity, intent),
            this.collectIncidents(entity, this.changeLookbackMs),
        ]);
        return {
            entity,
            topology: topologyCtx,
            recentChanges,
            sloStatus,
            historicalIncidents,
            collectedAt,
        };
    }

    /**
     * Resolve entity name to canonical node ID using fuzzy matching.
     * Order: exact name → exact ID → startsWith → includes → original string.
     */
    resolveEntityId(entity) {
        const byName = this.topology.findNodeByName(entity);
        if (byName)
            return byName.id;
        const byId = this.topology.getNode(entity);
        if (byId)
            return byId.id;
        const lower = entity.toLowerCase();
        const nodes = this.topology.listNodes();
        // startsWith: "checkout" → "checkout-service", or "checkout-service" → "checkout"
        const startsWithMatch = nodes.find((n) => n.name.toLowerCase().startsWith(lower) ||
            lower.startsWith(n.name.toLowerCase()));
        if (startsWithMatch)
            return startsWithMatch.id;
        // includes: "checkout" inside "my-checkout-svc"
        const includesMatch = nodes.find((n) => n.name.toLowerCase().includes(lower) ||
            lower.includes(n.name.toLowerCase()));
        if (includesMatch)
            return includesMatch.id;
        return entity;
    }

    collectTopology(entity, resolvedId) {
        // Try lookup by name first, then by node ID
        const node = this.topology.findNodeByName(entity) ??
            this.topology.getNode(resolvedId) ??
            null;
        const nodeId = node?.id ?? resolvedId;
        const dependencies = this.topology.getServiceDependencies(nodeId);
        const dependents = this.topology.getServiceDependents(nodeId);
        return Promise.resolve({ node, dependencies, dependents });
    }

    collectChanges(canonicalId, start, end) {
        const results = this.changes.query({
            serviceId: canonicalId,
            startTime: start,
            endTime: end,
        });
        return Promise.resolve(results);
    }

    async collectSloStatus(entity, intent) {
        if (!this.sloProvider) {
            return [];
        }
        // Use the intent's signal as the window if available, otherwise default
        const window = this.deriveWindow(intent);
        return this.sloProvider.getStatus(entity, window);
    }

    async collectIncidents(entity, lookbackMs) {
        if (!this.incidentProvider)
            return [];
        return this.incidentProvider.getRecent(entity, lookbackMs);
    }

    deriveWindow(intent) {
        const durationMs = new Date(intent.timeRange.end).getTime() -
            new Date(intent.timeRange.start).getTime();
        const hours = Math.round(durationMs / (60 * 60 * 1000));
        if (hours <= 1)
            return '1h';
        if (hours <= 6)
            return '6h';
        if (hours <= 24)
            return '24h';
        return `${hours}h`;
    }
}
//# sourceMappingURL=context-agent.js.map