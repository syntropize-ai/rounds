/**
 * Background-orchestrator factory.
 *
 * Builds a fully-wired `OrchestratorAgent` for non-interactive callers
 * (alert.fired auto-investigations, scheduled report generation, etc.).
 * Lives separately from `chat-service.ts` because chat-service is
 * session-scoped (sessionId, connector pin bag, conversation history,
 * SSE event stream) and a background run has none of those.
 *
 * The factory closes over long-lived dependencies (persistence, RBAC
 * surface, audit writer) and resolves runtime config (LLM, connectors,
 * ops connectors) on each call. That mirrors chat-service's behavior so
 * a runtime config change takes effect on the next background run
 * without restarting the api-gateway.
 *
 * Returned closure satisfies `BackgroundRunnerDeps.makeOrchestrator`.
 */

import { randomUUID } from 'node:crypto';
import type { Identity, IFolderRepository } from '@agentic-obs/common';
import {
  createAgentRunner,
  type AgentRunner,
  type AgentType,
  type IConversationStore as IAgentConversationStore,
  type IInvestigationStore,
} from '@agentic-obs/agent-core';
import { DuckDuckGoSearchAdapter } from '@agentic-obs/adapters';
import { createLlmGateway, createDbAuditSink } from '../routes/llm-factory.js';
import {
  buildAdapterRegistry,
  toAgentConnectors,
} from '../services/dashboard-service.js';
import { toAlertRuleStore } from '../services/chat-service.js';
import type { Persistence } from './persistence.js';
import type { SetupConfigService } from '../services/setup-config-service.js';
import type { AccessControlSurface } from '../services/accesscontrol-holder.js';
import type { AuditWriter } from '../auth/audit-writer.js';
import type { IApprovalRequestRepository } from '@agentic-obs/data-layer';

const NOOP_CONVERSATION_STORE: IAgentConversationStore = {
  getMessages: async () => [],
  addMessage: async (_key, msg) => msg,
  clearMessages: async () => undefined,
  deleteConversation: async () => undefined,
};

const sharedWebSearchAdapter = new DuckDuckGoSearchAdapter();

export interface BackgroundOrchestratorFactoryDeps {
  persistence: Persistence;
  setupConfig: SetupConfigService;
  accessControl: AccessControlSurface;
  audit?: AuditWriter;
  /** Optional folder backend — enables folder.create / folder.list tools. */
  folderRepository?: IFolderRepository;
  /**
   * Override the approval-request repo used by the agent's plan handler.
   * Wired at boot to a publishing wrapper so plan-level `submit()` calls
   * publish `approval.created` (T3.1). Falls back to the persistence repo
   * when omitted (tests / pre-T3.1 callers).
   */
  approvalsOverride?: IApprovalRequestRepository;
}

export type MakeBackgroundOrchestrator = (overrides: {
  identity: Identity;
  agentType?: AgentType;
}) => Promise<AgentRunner>;

/**
 * Build the closure passed as `BackgroundRunnerDeps.makeOrchestrator`.
 * Each invocation:
 *   - reads current LLM config from setupConfig (throws if not configured)
 *   - reads current connectors + builds the adapter registry
 *   - rebuilds OpsCommandRunnerService scoped to the caller's orgId
 *   - constructs a fresh OrchestratorAgent with a noop conversation store
 *     and a noop sendEvent (no SSE for background)
 */
export function buildBackgroundOrchestratorFactory(
  deps: BackgroundOrchestratorFactoryDeps,
): MakeBackgroundOrchestrator {
  return async ({ identity, agentType }) => {
    const llm = await deps.setupConfig.getLlm();
    if (!llm) {
      throw new Error('LLM not configured — complete the Setup Wizard before running background investigations');
    }
    const connectors = await deps.setupConfig.listConnectors({ orgId: identity.orgId });
    // Task 04 — DB-backed audit sink. Persistence carries the llmAudit repo
    // for both backends; falling back is fine for tests / minimal deployments.
    const llmAuditRepo = deps.persistence.repos.llmAudit;
    const auditSink = llmAuditRepo ? createDbAuditSink(llmAuditRepo) : undefined;
    const gateway = createLlmGateway(llm, undefined, auditSink);
    const adapters = buildAdapterRegistry(
      connectors,
      [],
    );

    return createAgentRunner({
      gateway,
      model: llm.model,
      store: deps.persistence.repos.dashboards,
      conversationStore: NOOP_CONVERSATION_STORE,
      investigationReportStore: deps.persistence.repos.investigationReports,
      investigationStore: deps.persistence.repos.investigations as IInvestigationStore | undefined,
      alertRuleStore: toAlertRuleStore(deps.persistence.repos.alertRules),
      ...(deps.folderRepository ? { folderRepository: deps.folderRepository } : {}),
      adapters,
      webSearchAdapter: sharedWebSearchAdapter,
      allConnectors: toAgentConnectors(connectors),
      remediationPlans: deps.persistence.repos.remediationPlans,
      approvalRequests: deps.approvalsOverride ?? deps.persistence.repos.approvals,
      // Background runs have no SSE channel; tool events are still logged
      // via the agent's internal logger but not streamed anywhere.
      sendEvent: () => undefined,
      identity,
      accessControl: deps.accessControl,
      ...(deps.audit ? { auditWriter: deps.audit } : {}),
      ...(agentType ? { agentType } : {}),
    }, `bg_${randomUUID()}`);
  };
}
