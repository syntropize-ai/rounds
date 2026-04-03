// Dashboard agents - product-facing agents for dashboard management

export { OrchestratorAgent } from './orchestrator-agent.js'
export type { OrchestratorDeps } from './orchestrator-agent.js'

export { DashboardGeneratorAgent } from './dashboard-generator-agent.js'
export { PanelAdderAgent } from './panel-adder-agent.js'
export type { PanelAdderInput, PanelAdderOutput } from './panel-adder-agent.js'

export { PanelBuilderAgent } from './panel-builder-agent.js'
export type { PanelBuilderInput, PanelBuilderOutput } from './panel-builder-agent.js'

export { InvestigationAgent } from './investigation-agent.js'
export type { InvestigationDeps, InvestigationInput, InvestigationOutput } from './investigation-agent.js'

export { AlertRuleAgent } from './alert-rule-agent.js'
export type { AlertRuleContext } from './alert-rule-agent.js'

export { ResearchAgent } from './research-agent.js'
export type { ResearchResult } from './research-agent.js'

export { DiscoveryAgent } from './discovery-agent.js'
export type { DiscoveryResult } from './discovery-agent.js'

export { ActionExecutor } from './action-executor.js'

export { ReActLoop } from './react-loop.js'
export type { ReActStep, ReActObservation, ReActDeps } from './react-loop.js'

export { PanelValidator } from './panel-validator.js'

export { ResearchPhase, DiscoveryPhase, GenerationPhase } from './phases/index.js'
export type { ResearchPhaseResult } from './phases/index.js'

export type {
  // Shared types
  DashboardPlan,
  PanelGroup,
  PanelSpec,
  VariableSuggestion,
  CriticFeedback,
  CriticIssue,
  RawPanelSpec,
  GeneratorDeps,
  GenerateInput,
  GenerateOutput,
  // Injected dependency interfaces
  IDashboardAgentStore,
  IConversationStore,
  IInvestigationReportStore,
  IAlertRuleStore,
  DatasourceConfig,
} from './types.js'
