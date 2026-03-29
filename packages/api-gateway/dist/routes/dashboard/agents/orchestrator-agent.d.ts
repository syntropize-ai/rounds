import type { LLMGateway } from '@agentic-obs/llm-gateways';
import type { DashboardSSEEvent } from '@agentic-obs/common';
import type { DatasourceConfig } from '../../ui/setup.js';
import type { IGatewayDashboardStore, IConversationStore } from '../../../repositories/types.js';
export interface OrchestratorDeps {
    gateway: LLMGateway;
    model: string;
    prometheusUrl?: string;
    prometheusHeaders: Record<string, string>;
    datasources?: DatasourceConfig[];
    store: IGatewayDashboardStore;
    conversationStore: IConversationStore;
    sendEvent: (event: DashboardSSEEvent) => void;
}
export declare class OrchestratorAgent {
    private deps;
    private actionExecutor;
    private generatorAgent;
    private panelAdderAgent;
    private investigationAgent?;
    private alertRuleAgent;
    constructor(deps: OrchestratorDeps);
    handleMessage(dashboardId: string, message: string): Promise<string>;
    private runReActLoop;
    private buildSystemPrompt;
    private buildMessages;
}
//# sourceMappingURL=orchestrator-agent.d.ts.map
