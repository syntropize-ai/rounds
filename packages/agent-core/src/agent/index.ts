// Core agent — single autonomous orchestrator with primitive tools

export { OrchestratorAgent } from './orchestrator-agent.js'
export type { OrchestratorDeps } from './orchestrator-agent.js'

// Single entry point for api-gateway. Wires the audit-writer bridge so
// agent-tool mutations actually persist audit rows.
export { createAgentRunner } from './factory.js'
export type { AgentRunner, CreateAgentRunnerDeps } from './factory.js'

export { ActionExecutor } from './action-executor.js'

export { ReActLoop } from './react-loop.js'
export type { ReActStep, ReActObservation, ReActDeps } from './react-loop.js'

// Wave 7 — permission gate + specialized agent plumbing.
export {
  TOOL_PERMS,
  UNGATED_TOOLS,
  buildToolEvaluator,
} from './tool-permissions.js'
export {
  checkPermission,
  denialObservation,
} from './permission-gate.js'
export type {
  ToolPermissionBuilder,
  IAccessControlService,
  IAuditWriter,
  PermissionDenyReason,
  PermissionGateResult,
} from './types-permissions.js'
export {
  runBackgroundAgent,
  type BackgroundAgentRunInput,
  type BackgroundRunnerDeps,
  type ISaTokenResolver,
} from './background-runner.js'

// Agent runtime types
export * from './agent-types.js'
export * from './agent-definition.js'
export * from './agent-events.js'
export { agentRegistry } from './agent-registry.js'

export type {
  IDashboardAgentStore,
  IConversationStore,
  IInvestigationReportStore,
  IInvestigationStore,
  IAlertRuleStore,
  ConnectorConfig,
  OpsCommandIntent,
  OpsConnectorConfig,
  OpsCommandRunner,
  ApprovalAction,
  ApprovalContext,
  ApprovalRequest,
  ApprovalRequestStore,
  AgentRemediationPlan,
  NewRemediationPlanStep,
  RemediationPlanStepKind,
  RemediationPlanStore,
  AgentConfigService,
} from './types.js'

// Context compaction
export { shouldCompact, compactMessages } from './context-compaction.js'
export type { CompactedContext } from './context-compaction.js'
export { estimateTokens, estimateMessagesTokens, COMPACTION_THRESHOLD, CONTEXT_WINDOW, KEEP_RECENT_MESSAGES, SUMMARY_MAX_TOKENS } from './token-utils.js'
