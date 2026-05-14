// @agentic-obs/agent-core

export * from './adapters/index.js';

export {
  createAgentRunner,
  type AgentRunner,
  type CreateAgentRunnerDeps,
  OrchestratorAgent,
  type OrchestratorDeps,
  // Compat alias — api-gateway still imports under the old name
  OrchestratorAgent as DashboardOrchestratorAgent,
  type OrchestratorDeps as DashboardOrchestratorDeps,
  ActionExecutor,
  type IDashboardAgentStore,
  type IConversationStore,
  type IInvestigationReportStore,
  type IAlertRuleStore,
  type IInvestigationStore,
  type ConnectorConfig,
  type OpsCommandRunner,
  type OpsConnectorConfig,
  type OpsCommandIntent,
  type ApprovalAction,
  type ApprovalContext,
  type ApprovalRequest,
  type ApprovalRequestStore,
  type AgentRemediationPlan,
  type NewRemediationPlanStep,
  type RemediationPlanStepKind,
  type RemediationPlanStore,
  type AgentConfigService,
  // Compat aliases
  type IConversationStore as IDashboardConversationStore,
  type IAlertRuleStore as IDashboardAlertRuleStore,
  type IInvestigationStore as IDashboardInvestigationStore,
  type ConnectorConfig as DashboardConnectorConfig,
  // Context compaction
  shouldCompact,
  compactMessages,
  type CompactedContext,
  estimateTokens,
  estimateMessagesTokens,
  COMPACTION_THRESHOLD,
  CONTEXT_WINDOW,
  KEEP_RECENT_MESSAGES,
  SUMMARY_MAX_TOKENS,
} from './agent/index.js';

export type { Investigation, InvestigationPlan, InvestigationStatus } from '@agentic-obs/common';

export {
  runBackgroundAgent,
  type BackgroundRunnerDeps,
} from './agent/background-runner.js';

export type { AgentType } from './agent/agent-types.js';

// Wave 2 / Step 5 — provisioned diff helper. Re-exported here so the
// orchestrator and the api-gateway router can both reach it without crossing
// internal package boundaries.
export {
  generateProvisionedDiff,
  type ProvisionedDiffProvenance,
} from './agent/provisioned-diff.js';
