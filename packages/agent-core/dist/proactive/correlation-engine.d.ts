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
export type Symptom = {
    source: 'anomaly';
    finding: AnomalyFinding;
} | {
    source: 'burn_rate';
    finding: BurnRateFinding;
};
export interface IncidentDraft {
    id: string;
    title: string;
    severity: 'P1' | 'P2' | 'P3' | 'P4';
    affectedServices: string[];
    symptoms: Symptom[];
    changes: Change[];
    correlationReasons: string[];
    createdAt: string;
}
export interface TopologyProvider {
    getRelatedServices(serviceId: string): string[];
}
export interface CorrelationEngineConfig {
    correlationWindowMs?: number;
    checkIntervalMs?: number;
    topology?: TopologyProvider;
}
/** No-op provider when topology information is unavailable. */
export declare class NoopTopologyProvider implements TopologyProvider {
    getRelatedServices(_serviceId: string): string[];
}
export declare class CorrelationEngine {
    private symptoms;
    private changes;
    private readonly correlationWindowMs;
    private readonly checkIntervalMs;
    private readonly topology;
    private readonly listeners;
    private readonly usedSymptomIds;
    private readonly usedChangeIds;
    private timer;
    private draftCounter;
    constructor(config?: CorrelationEngineConfig);
    ingestAnomalyFinding(finding: AnomalyFinding): void;
    ingestBurnRateFinding(finding: BurnRateFinding): void;
    ingestChange(change: Change): void;
    onIncident(listener: (draft: IncidentDraft) => void): void;
    start(): void;
    stop(): void;
    correlate(): IncidentDraft[];
    private buildDraft;
    private deriveSeverity;
    private groupByService;
    private symptomId;
    private markUsed;
    private emit;
    private windowLabel;
    private pruneExpired;
}
//# sourceMappingURL=correlation-engine.d.ts.map