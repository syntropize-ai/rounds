import type { LLMGateway } from '@agentic-obs/llm-gateways';
import type { PanelConfig, DashboardSSEEvent, InvestigationReport } from '@agentic-obs/common';
export interface InvestigationDeps {
    gateway: LLMGateway;
    model: string;
    prometheusUrl: string;
    prometheusHeaders: Record<string, string>;
    sendEvent: (event: DashboardSSEEvent) => void;
}
export interface InvestigationInput {
    goal: string;
    existingPanels: PanelConfig[];
    gridNextRow: number;
    availableMetrics?: string[];
}
export declare class InvestigationAgent {
    private gateway;
    private model;
    private prometheusUrl;
    private headers;
    private sendEvent;
    constructor(deps: InvestigationDeps);
    investigate(input: InvestigationInput): Promise<{
        summary: string;
        panels: PanelConfig[];
        report: InvestigationReport;
    }>;
    private planInvestigation;
    private executeQueries;
    private analyzeEvidence;
    private toPanelConfig;
}
//# sourceMappingURL=investigation-agent.d.ts.map
