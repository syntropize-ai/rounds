import type { LLMGateway } from '@agentic-obs/llm-gateway';
import type { DashboardSseEvent } from '@agentic-obs/common';
export interface ResearchResult {
    topic: string;
    keyMetrics: string[];
    metricPrefixes: string[];
    monitoringApproach: string;
    bestPractices: string[];
    panelSuggestions: string[];
    rawContext: string;
}
export declare class ResearchAgent {
    private gateway;
    private model;
    private sendEvent;
    constructor(gateway: LLMGateway, model: string, sendEvent: (event: DashboardSseEvent) => void);
    research(topic: string): Promise<ResearchResult>;
    private buildSearchQuery;
    private webSearch;
    private extractKnowledge;
}
//# sourceMappingURL=research-agent.d.ts.map