/**
 * Background-orchestrator factory.
 *
 * Builds a fully-wired `OrchestratorAgent` for non-interactive callers
 * (alert.fired auto-investigations, scheduled report generation, etc.).
 * Lives separately from `chat-service.ts` because chat-service is
 * session-scoped (sessionId, datasource pin bag, conversation history,
 * SSE event stream) and a background run has none of those.
 *
 * The factory closes over long-lived dependencies (persistence, RBAC
 * surface, audit writer) and resolves runtime config (LLM, datasources,
 * ops connectors) on each call. That mirrors chat-service's behavior so
 * a runtime config change takes effect on the next background run
 * without restarting the api-gateway.
 *
 * Returned closure satisfies `BackgroundRunnerDeps.makeOrchestrator`.
 */

import { randomUUID } from 'node:crypto';
import type { Identity, IFolderRepository } from '@agentic-obs/common';
import {
  DashboardOrchestratorAgent as OrchestratorAgent,
  type AgentType,
  type IConversationStore as IAgentConversationStore,
  type IInvestigationStore,
} from '@agentic-obs/agent-core';
import { DuckDuckGoSearchAdapter } from '@agentic-obs/adapters';
import { createLlmGateway } from '../routes/llm-factory.js';
import { OpsCommandRunnerService } from '../services/ops-command-runner-service.js';
import {
  buildAdapterRegistry,
  toAgentDatasources,
} from '../services/dashboard-service.js';
import { toAlertRuleStore } from '../services/chat-service.js';
import type { Persistence } from './persistence.js';
import type { SetupConfigService } from '../services/setup-config-service.js';
import type { AccessControlSurface } from '../services/accesscontrol-holder.js';
import type { AuditWriter } from '../auth/audit-writer.js';
import type { GitHubChangeSourceRegistry } from '../services/github-change-source-service.js';

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
  /** In-process GitHub/change sources. */
  githubChangeSources?: GitHubChangeSourceRegistry;
}

export type MakeBackgroundOrchestrator = (overrides: {
  identity: Identity;
  agentType?: AgentType;
}) => Promise<OrchestratorAgent>;

/**
 * Build the closure passed as `BackgroundRunnerDeps.makeOrchestrator`.
 * Each invocation:
 *   - reads current LLM config from setupConfig (throws if not configured)
 *   - reads current datasources + builds the adapter registry
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
    const datasources = await deps.setupConfig.listDatasources({ orgId: identity.orgId });
    const gateway = createLlmGateway(llm);
    const adapters = buildAdapterRegistry(
      datasources,
      deps.githubChangeSources ? await deps.githubChangeSources.listAdapters(identity.orgId) : [],
    );

    const opsCommandRunner = deps.persistence.repos.opsConnectors && deps.persistence.repos.approvals
      ? new OpsCommandRunnerService({
          connectors: deps.persistence.repos.opsConnectors,
          approvals: deps.persistence.repos.approvals,
        }, identity.orgId)
      : undefined;
    const opsConnectors = opsCommandRunner ? await opsCommandRunner.listConnectors() : undefined;

    return new OrchestratorAgent({
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
      allDatasources: toAgentDatasources(datasources),
      ...(opsCommandRunner ? { opsCommandRunner, opsConnectors } : {}),
      remediationPlans: deps.persistence.repos.remediationPlans,
      approvalRequests: deps.persistence.repos.approvals,
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
