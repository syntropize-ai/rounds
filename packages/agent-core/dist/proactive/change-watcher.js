/**
 * Change Watcher - polls ChangeEventStore for new change events and
 * automatically triggers investigations via AgentOrchestrator.
 *
 * Follows the same start/stop/check pattern as SloBurnMonitor.
 */
export class ChangeWatcher {
    store;
    orchestrator;
    config;
    seenIds = new Set();
    /** Insertion-order record used for FIFO eviction when seenIds exceeds maxSeenIds. */
    seenIdsOrder = [];
    listeners = [];
    timer = null;
    constructor(store, orchestrator, config) {
        this.store = store;
        this.orchestrator = orchestrator;
        const pollIntervalMs = config.pollIntervalMs ?? 60_000;
        this.config = {
            pollIntervalMs,
            lookbackWindowMs: config.lookbackWindowMs ?? pollIntervalMs * 2,
            filter: config.filter ?? {},
            maxSeenIds: config.maxSeenIds ?? 10_000,
            tenantId: config.tenantId,
            userId: config.userId,
        };
    }
    onFinding(listener) {
        this.listeners.push(listener);
    }
    start() {
        if (this.timer) {
            return;
        }
        void this.check();
        this.timer = setInterval(() => void this.check(), this.config.pollIntervalMs);
    }
    stop() {
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = null;
        }
    }
    async check() {
        const now = Date.now();
        const endTime = new Date(now);
        const startTime = new Date(now - this.config.lookbackWindowMs);
        const changes = this.store.query({ startTime, endTime });
        const newChanges = changes.filter((c) => {
            if (this.seenIds.has(c.id))
                return false;
            return this.matchesFilter(c);
        });
        const findings = [];
        for (const change of newChanges) {
            this.addSeenId(change.id);
            const output = await this.orchestrator.run(this.buildInput(change));
            const finding = {
                change,
                orchestratorOutput: output,
                triggeredAt: new Date().toISOString(),
            };
            findings.push(finding);
            for (const listener of this.listeners) {
                listener(finding);
            }
        }
        return findings;
    }
    matchesFilter(change) {
        const { services, changeTypes } = this.config.filter;
        if (services && services.length > 0 && !services.includes(change.serviceId)) {
            return false;
        }
        if (changeTypes && changeTypes.length > 0 && !changeTypes.includes(change.type)) {
            return false;
        }
        return true;
    }
    buildInput(change) {
        return {
            message: `Investigate ${change.type} change on ${change.serviceId}: ${change.description ?? ''}`,
            tenantId: this.config.tenantId,
            userId: this.config.userId,
        };
    }
    addSeenId(id) {
        if (this.seenIds.has(id)) {
            return;
        }
        this.seenIds.add(id);
        this.seenIdsOrder.push(id);
        while (this.seenIds.size > this.config.maxSeenIds) {
            const oldest = this.seenIdsOrder.shift();
            if (oldest !== undefined) {
                this.seenIds.delete(oldest);
            }
        }
    }
}
//# sourceMappingURL=change-watcher.js.map