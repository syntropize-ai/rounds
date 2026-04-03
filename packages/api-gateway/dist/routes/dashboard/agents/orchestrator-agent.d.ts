import type { LLMGateway } from '@agentic-obs/llm-gateway';
import type { DashboardSseEvent } from '@agentic-obs/common';
import type { DatasourceConfig } from '../../setup.js';
import type { IGatewayDashboardStore, IConversationStore } from '../../../repositories/types.js';
export interface OrchestratorDeps {
    gateway: LLMGateway;
    model: string;
    store: IGatewayDashboardStore;
    conversationStore: IConversationStore;
    prometheusUrl: string | undefined;
    prometheusHeaders: Record<string, string>;
    /** All configured datasources - used to inform the LLM about available environments */
    allDatasources?: DatasourceConfig[];
    sendEvent: (event: DashboardSseEvent) => void;
}
export declare class OrchestratorAgent {
    private deps;
    private readonly actionExecutor;
    private readonly generatorAgent;
    private readonly panelAdderAgent;
    private readonly investigationAgent?;
    private readonly alertRuleAgent;
    constructor(deps: OrchestratorDeps);
    handleMessage(dashboardId: string, message: string): Promise<string>;
    private runReActLoop;
    private buildSystemPrompt;
    private buildMessages;
}
//# sourceMappingURL=orchestrator-agent.d.ts.map