/**
 * Change Watcher - polls ChangeEventStore for new change events and
 * automatically triggers investigations via AgentOrchestrator.
 *
 * Follows the same start/stop/check pattern as SloBurnMonitor.
 */
import type { Change } from '@agentic-obs/common';
import type { OrchestratorOutput } from '../orchestrator/types.js';
export interface ChangeEventStore {
    query(input: {
        startTime: Date;
        endTime: Date;
    }): Change[];
}
export interface OrchestratorRunner {
    run(input: {
        message: string;
        tenantId: string;
        userId: string;
    }): Promise<OrchestratorOutput>;
}
export interface ChangeWatcherFinding {
    change: Change;
    orchestratorOutput: OrchestratorOutput;
    triggeredAt: string;
}
export interface ChangeWatcherConfig {
    pollIntervalMs?: number;
    lookbackWindowMs?: number;
    filter?: {
        services?: string[];
        changeTypes?: string[];
    };
    maxSeenIds?: number;
    tenantId: string;
    userId: string;
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
    constructor(store: ChangeEventStore, orchestrator: OrchestratorRunner, config: ChangeWatcherConfig);
    onFinding(listener: (finding: ChangeWatcherFinding) => void): void;
    start(): void;
    stop(): void;
    check(): Promise<ChangeWatcherFinding[]>;
    private matchesFilter;
    private buildInput;
    private addSeenId;
}
//# sourceMappingURL=change-watcher.d.ts.map