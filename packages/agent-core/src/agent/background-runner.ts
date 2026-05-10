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
  /**
   * Raw SA token (`openobs_sa_...`). One of `saToken` or `identity` must
   * be provided. When `saToken` is supplied it is resolved through
   * `deps.saTokens.validateAndLookup`.
   */
  saToken?: string;
  /**
   * Pre-resolved identity. Used when the caller already has a trusted
   * identity (e.g. an in-process dispatcher that resolved the SA from the
   * user table) and so does not need a plaintext token round-trip. When
   * `identity` is supplied the SA-token resolver is skipped entirely.
   */
  identity?: Identity;
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
  /**
   * May return synchronously OR a Promise. Async builders are useful when
   * the orchestrator needs runtime config (LLM, connectors)
   * that can change between calls — fetch it inside the factory, not at
   * BackgroundRunnerDeps construction time.
   */
  makeOrchestrator: (
    overrides: Pick<OrchestratorDeps, 'identity'> & {
      agentType?: AgentType;
    },
  ) => OrchestratorAgent | Promise<OrchestratorAgent>;
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
  let identity: Identity;
  if (input.identity) {
    identity = input.identity;
  } else {
    if (!input.saToken || typeof input.saToken !== 'string') {
      throw new Error('runBackgroundAgent: saToken or identity is required');
    }
    const lookup = await deps.saTokens.validateAndLookup(input.saToken);
    if (!lookup) {
      throw new Error(
        'runBackgroundAgent: SA token failed to resolve — revoked, expired, or not found. ' +
          'Rotate the operator token and retry.',
      );
    }
    identity = {
      userId: lookup.user.id,
      orgId: lookup.orgId,
      orgRole: lookup.role,
      isServerAdmin: lookup.isServerAdmin,
      authenticatedBy: 'api_key',
      serviceAccountId: lookup.serviceAccountId ?? undefined,
    };
  }

  const agent = await deps.makeOrchestrator({
    identity,
    ...(input.agentType ? { agentType: input.agentType } : {}),
  });

  return agent.handleMessage(input.message, input.dashboardId);
}
