import type { DashboardSSEEvent } from '@agentic-obs/common';
export interface DiscoveryResult {
    metrics: string[];
    labelsByMetric: Record<string, string[]>;
    sampleValues: Record<string, {
        count: number;
        sampleLabels: Record<string, string>[];
    }>;
    totalMetrics: number;
}
export declare class DiscoveryAgent {
    private prometheusUrl;
    private headers;
    private sendEvent;
    constructor(prometheusUrl: string, headers: Record<string, string>, sendEvent: (event: DashboardSSEEvent) => void);
    /** Fetch all metric names from Prometheus (no filtering). */
    fetchAllMetricNames(): Promise<string[]>;
    discover(patterns: string[]): Promise<DiscoveryResult>;
    private fetchMetricNames;
    private filterByPatterns;
    private fetchLabels;
    private sampleMetric;
}
//# sourceMappingURL=discovery-agent.d.ts.map
