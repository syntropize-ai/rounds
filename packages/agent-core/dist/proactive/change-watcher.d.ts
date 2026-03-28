/**
 * Change Watcher - polls ChangeEventStore for new change events and
 * automatically triggers investigations via AgentOrchestrator.
 *
 * Follows the same start/stop/check pattern as SloBurnMonitor.
 */
import type { Change } from '@agentic-obs/common';
import type { ChangeEventStore } from '@agentic-obs/adapters';
import type { OrchestratorInput, OrchestratorOutput } from '../orchestrator/types.js';

export interface ChangeOrchestrator {
    run(input: OrchestratorInput): Promise<OrchestratorOutput>;
}

export interface ChangeWatcherFilter {
    /** If set, only these serviceIds will trigger investigations. */
    services?: string[];
    /** If set, only these change types will trigger investigations. */
    changeTypes?: Array<Change['type']>;
}

export interface ChangeWatcherConfig {
    /** How often to poll the store in ms (default: 60_000) */
    pollIntervalMs?: number;
    /**
     * How far back in time to look when polling (ms, default: 2 * pollIntervalMs).
     * Set to a larger value on startup to catch changes that arrived before the
     * watcher started.
     */
    lookbackWindowMs?: number;
    /** Filter rules - leave undefined to watch all services/types. */
    filter?: ChangeWatcherFilter;
    /**
     * Maximum number of change IDs to keep in the dedup set.
     * When the limit is reached the oldest IDs are evicted (FIFO).
     * Default: 10_000.
     */
    maxSeenIds?: number;
    /** tenantId forwarded to OrchestratorInput */
    tenantId?: string;
    /** userId forwarded to OrchestratorInput */
    userId?: string;
}

export interface ChangeWatcherFinding {
    change: Change;
    orchestratorOutput: OrchestratorOutput;
    triggeredAt: string;
}

export declare class ChangeWatcher {
    private readonly store;
    private readonly orchestrator;
    private readonly config;
    private readonly seenIds;
    /** Insertion-order record used for FIFO eviction when seenIds exceeds maxSeenIds. */
    private readonly seenIdsOrder;
    private readonly listeners;
    private timer;
    constructor(store: ChangeEventStore, orchestrator: ChangeOrchestrator, config: ChangeWatcherConfig);
    /** Register a listener that receives a finding for each auto-investigated change. */
    onFinding(listener: (finding: ChangeWatcherFinding) => void): void;
    /** Start periodic polling. Runs an initial check immediately. */
    start(): void;
    /** Stop periodic polling. */
    stop(): void;
    /**
     * Run a single poll cycle: query recent changes, filter, deduplicate,
     * and trigger an investigation for each new matching change.
     * Returns the findings produced in this cycle.
     */
    check(): Promise<ChangeWatcherFinding[]>;
    private matchesFilter;
    private buildInput;
    /**
     * Add a change ID to the dedup set, evicting the oldest entry (FIFO) when
     * the set would exceed maxSeenIds. O(1) amortised.
     */
    private addSeenId;
}
//# sourceMappingURL=change-watcher.d.ts.map
