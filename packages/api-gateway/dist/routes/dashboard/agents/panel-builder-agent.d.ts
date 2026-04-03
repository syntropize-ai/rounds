import type { LLMGateway } from '@agentic-obs/llm-gateway';
import type { PanelConfig, DashboardVariable, DashboardSseEvent } from '@agentic-obs/common';
export interface PanelBuilderInput {
    goal: string;
    scope: 'single' | 'group' | 'comprehensive';
    availableMetrics: string[];
    labelsByMetric: Record<string, string[]>;
    researchContext?: string;
    /** Structured metric names from research (exact names the technology exposes) */
    keyMetrics?: string[];
    /** Metric name prefixes from research (for pattern matching) */
    metricPrefixes?: string[];
    existingPanels: PanelConfig[];
    existingVariables: DashboardVariable[];
    gridNextRow: number;
}
export interface PanelBuilderOutput {
    panels: PanelConfig[];
    variables?: DashboardVariable[];
}
export declare class PanelBuilderAgent {
    private gateway;
    private model;
    private prometheusUrl;
    private headers;
    private sendEvent;
    constructor(gateway: LLMGateway, model: string, prometheusUrl: string | undefined, headers: Record<string, string>, sendEvent: (event: DashboardSseEvent) => void);
    build(input: PanelBuilderInput): Promise<PanelBuilderOutput>;
    private generatePanels;
    private validateAndCorrect;
    private validateSinglePanel;
    /**
     * Validate a PromQL expression. On failure, attempt self-correction via LLM.
     * Returns the final (possibly corrected) expression, or null if max retries exceeded.
     */
    private validateAndFixQuery;
    /** Execute a PromQL instant query against Prometheus to validate it */
    private queryPrometheus;
    /** Ask LLM to rewrite a failing PromQL expression */
    private fixQueryWithLLM;
    /**
     * Extract potential metric name tokens from a PromQL expression
     * and find similar names in the available metrics list.
     */
    private findSimilarMetrics;
    private detectVariables;
}
//# sourceMappingURL=panel-builder-agent.d.ts.map