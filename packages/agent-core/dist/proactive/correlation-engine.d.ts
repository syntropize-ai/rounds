/**
 * Correlation Engine v1 - correlates symptoms and changes within a time
 * window and produces IncidentDraft objects for automated investigation.
 *
 * Correlation rules (any match triggers an Incident):
 * 1. change + symptom on the same service within the window
 * 2. 2 symptoms on the same service within the window
 * 3. symptoms on topology-related services within the window
 */
import type { Change } from '@agentic-obs/common';
import type { AnomalyFinding } from './anomaly-detector.js';
import type { BurnRateFinding } from './slo-burn-monitor.js';

export type CorrelatedSymptom = {
    source: 'anomaly';
    finding: AnomalyFinding;
} | {
    source: 'burn_rate';
    finding: BurnRateFinding;
};

export type DraftSeverity = 'P1' | 'P2' | 'P3' | 'P4';

export interface IncidentDraft {
    id: string;
    /** Human-readable title summarising the incident */
    title: string;
    severity: DraftSeverity;
    affectedServices: string[];
    symptoms: CorrelatedSymptom[];
    changes: Change[];
    /** Why these signals were grouped together. */
    correlationReasons: string[];
    createdAt: string;
}

/**
 * Minimal interface the engine needs to check topology relationships.
 * Pass a real TopologyStore adapter or a test stub.
 */
export interface TopologyProvider {
    /** Returns service IDs directly related (upstream or downstream) to serviceId. */
    getRelatedServices(serviceId: string): string[];
}

/** No-op provider when topology information is unavailable. */
export declare class NoopTopologyProvider implements TopologyProvider {
    getRelatedServices(_serviceId: string): string[];
}

export interface CorrelationEngineConfig {
    /**
     * Time window in ms within which co-occurring events are considered related.
     * Default: 30 minutes.
     */
    correlationWindowMs?: number;
    /** How often to run automatic correlation in ms (default: 60_000). */
    checkIntervalMs?: number;
    /** Topology provider for cross-service correlation (default: no-op). */
    topology?: TopologyProvider;
}

export declare class CorrelationEngine {
    private readonly symptoms;
    private readonly changes;
    private readonly correlationWindowMs;
    private readonly checkIntervalMs;
    private readonly topology;
    private readonly listeners;
    /** IDs of symptoms already included in an emitted IncidentDraft. */
    private readonly usedSymptomIds;
    /** IDs of changes already included in an emitted IncidentDraft. */
    private readonly usedChangeIds;
    private timer;
    private draftCounter;
    constructor(config?: CorrelationEngineConfig);
    /** Add an anomaly finding to the correlation buffer. */
    ingestAnomalyFinding(finding: AnomalyFinding): void;
    /** Add a burn-rate finding to the correlation buffer. */
    ingestBurnRateFinding(finding: BurnRateFinding): void;
    /** Add a change event to the correlation buffer. */
    ingestChange(change: Change): void;
    /** Register a callback invoked for each new IncidentDraft. */
    onIncident(listener: (draft: IncidentDraft) => void): void;
    /** Start periodic correlation. Runs an immediate check then polls on interval. */
    start(): void;
    /** Stop periodic correlation. */
    stop(): void;
    /**
     * Run a single correlation pass over the current buffer.
     * Returns newly produced IncidentDrafts (not previously emitted ones).
     */
    correlate(): IncidentDraft[];
    private buildDraft;
    private deriveSeverity;
    private groupByService;
    private symptomId;
    private markUsed;
    private emit;
    private windowLabel;
    /**
     * Remove events that have aged out of the correlation window from the
     * in-memory buffers and clean up the corresponding usedXxxIds entries.
     * Called at the end of every correlate() cycle to keep the arrays bounded.
     */
    private pruneExpired;
}
//# sourceMappingURL=correlation-engine.d.ts.map
