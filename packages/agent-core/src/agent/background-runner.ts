/**
 * Background runner — starts an agent on behalf of a service account token
 * when there is no human caller (proactive investigator cron, scheduled
 * report generator, alert-triggered auto-dig).
 *
 * The runner resolves an `openobs_sa_...` token through an SA-lookup function
 * (typically `ApiKeyService.validateAndLookup`), produces an `Identity`, and
 * wires it through `OrchestratorAgent`. Tokens that don't resolve or are
 * revoked produce a clear error — NEVER a fallback to server-admin.
 *
 * See docs/auth-perm-design/11-agent-permissions.md §D4.
 */

import type { Identity } from '@agentic-obs/common';
import type { OrchestratorAgent, OrchestratorDeps } from './orchestrator-agent.js';
import type { AgentType } from './agent-types.js';

/**
 * Minimal SA-lookup surface the runner depends on. api-gateway's
 * `ApiKeyService.validateAndLookup` conforms directly.
 */
export interface ISaTokenResolver {
  validateAndLookup(rawToken: string): Promise<{
    user: { id: string; isAdmin: boolean };
    orgId: string;
    role: Identity['orgRole'];
    serviceAccountId: string | null;
    keyId?: string;
    isServerAdmin: boolean;
  } | null>;
}

export interface BackgroundAgentRunInput {
  /** Which specialized agent type to start. Defaults to 'orchestrator'. */
  agentType?: AgentType;
  /** Raw SA token (`openobs_sa_...`). Required. */
  saToken: string;
  /** The message the agent should act on. */
  message: string;
  /** Optional dashboard scoping. */
  dashboardId?: string;
}

export interface BackgroundRunnerDeps {
  saTokens: ISaTokenResolver;
  /**
   * Factory for the orchestrator — injected so the runner doesn't depend on
   * the full dep graph of OrchestratorDeps directly. Callers build a factory
   * that closes over their store/gateway/accessControl singletons and only
   * feeds the runner the per-run fields (identity, agentType).
   */
  makeOrchestrator: (
    overrides: Pick<OrchestratorDeps, 'identity'> & {
      agentType?: AgentType;
    },
  ) => OrchestratorAgent;
}

/**
 * Run an agent with an identity derived from a service account token. Returns
 * the final reply string. Throws with a clear message if the token fails to
 * resolve — background callers should propagate the throw (cron jobs should
 * log + retry or page), not silently fall back to a server-admin principal.
 */
export async function runBackgroundAgent(
  deps: BackgroundRunnerDeps,
  input: BackgroundAgentRunInput,
): Promise<string> {
  if (!input.saToken || typeof input.saToken !== 'string') {
    throw new Error('runBackgroundAgent: saToken is required');
  }

  const lookup = await deps.saTokens.validateAndLookup(input.saToken);
  if (!lookup) {
    throw new Error(
      'runBackgroundAgent: SA token failed to resolve — revoked, expired, or not found. ' +
        'Rotate the operator token and retry.',
    );
  }

  const identity: Identity = {
    userId: lookup.user.id,
    orgId: lookup.orgId,
    orgRole: lookup.role,
    isServerAdmin: lookup.isServerAdmin,
    authenticatedBy: 'api_key',
    serviceAccountId: lookup.serviceAccountId ?? undefined,
  };

  const agent = deps.makeOrchestrator({
    identity,
    ...(input.agentType ? { agentType: input.agentType } : {}),
  });

  return agent.handleMessage(input.message, input.dashboardId);
}
