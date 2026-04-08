export * from './intent/index.js';
export * from './context/index.js';
export * from './investigation/index.js';
export * from './evidence/index.js';
export * from './orchestrator/index.js';
export * from './explanation/index.js';
export * from './execution/index.js';
export * from './proactive/index.js';
export * from './case-library/index.js';
export * from './postmortem/index.js';
export * from './scheduled/index.js';
export * from './alerting/index.js';
export * from './runtime/index.js';
export * from './verification/index.js';
export * from './adapters/index.js';
export { OrchestratorAgent as DashboardOrchestratorAgent, type OrchestratorDeps as DashboardOrchestratorDeps, DashboardGeneratorAgent, PanelAdderAgent, type PanelAdderInput, type PanelAdderOutput, PanelEditorAgent, type PanelEditorInput, type PanelEditorOutput, PanelExplainAgent, type PanelExplainDeps, type PanelExplainInput, PanelBuilderAgent, type PanelBuilderInput, type PanelBuilderOutput, InvestigationAgent as DashboardInvestigationAgent, type InvestigationDeps as DashboardInvestigationDeps, type InvestigationInput as DashboardInvestigationInput, type InvestigationOutput as DashboardInvestigationOutput, AlertRuleAgent, type AlertRuleContext, ResearchAgent, type ResearchResult, DiscoveryAgent, type DiscoveryResult, ActionExecutor, type IDashboardAgentStore, type IConversationStore as IDashboardConversationStore, type IInvestigationReportStore, type IAlertRuleStore as IDashboardAlertRuleStore, type DatasourceConfig as DashboardDatasourceConfig, type DashboardPlan, type PanelGroup, type PanelSpec, type VariableSuggestion, type CriticFeedback, type CriticIssue, type RawPanelSpec, type GeneratorDeps, type GenerateInput, type GenerateOutput, } from './dashboard-agents/index.js';
export type { Investigation, InvestigationPlan, InvestigationStatus } from '@agentic-obs/common';
export interface AgentContext {
    investigationId: string;
    tenantId: string;
    userId: string;
}
export interface AgentResult<T> {
    success: boolean;
    data?: T;
    error?: string;
}
export interface Agent<TInput, TOutput> {
    name: string;
    run(input: TInput, context: AgentContext): Promise<AgentResult<TOutput>>;
}
//# sourceMappingURL=index.d.ts.map