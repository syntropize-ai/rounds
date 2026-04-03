import type { LLMGateway } from '@agentic-obs/llm-gateway';
import type { PanelConfig, DashboardSseEvent, InvestigationReport } from '@agentic-obs/common';
export interface InvestigationDeps {
    gateway: LLMGateway;
    model: string;
    prometheusUrl: string;
    prometheusHeaders: Record<string, string>;
    sendEvent: (event: DashboardSseEvent) => void;
}
export interface InvestigationInput {
    goal: string;
    existingPanels: PanelConfig[];
    availableMetrics?: string[];
    gridNextRow: number;
}
export interface InvestigationOutput {
    /** Short 1-2 sentence summary for the chat reply */
    summary: string;
    /** Full structured report for the left-side report view */
    report: InvestigationReport;
    /** Evidence panels (already included in report sections too) */
    panels: PanelConfig[];
}
export declare class InvestigationAgent {
    private deps;
    constructor(deps: InvestigationDeps);
    investigate(input: InvestigationInput): Promise<InvestigationOutput>;
    private discoverMetrics;
    private planInvestigation;
    private executeQueries;
    private analyzeEvidence;
    private toPanelConfig;
}
//# sourceMappingURL=investigation-agent.d.ts.map