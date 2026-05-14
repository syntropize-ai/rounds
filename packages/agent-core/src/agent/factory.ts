/**
 * Agent factory — single entry point for constructing a fully-wired
 * `OrchestratorAgent` runner.
 *
 * Why this exists:
 *   - `api-gateway` previously imported the orchestrator class directly and
 *     wired internals (tool registry, audit reporter, action runner) per
 *     call site. That leaked agent lifecycle into the gateway package.
 *   - PR #185 added `ActionContext.auditWriter` as an optional slim
 *     fire-and-forget function, but no caller was bridging
 *     `AuditWriter.log` into that slot — so resource-mutation handlers
 *     (dashboard_create, alert_rule_write, …) silently wrote no audit
 *     rows. This factory is the natural place to install that bridge.
 *
 * Callers in api-gateway pass deps in and get an `AgentRunner` out;
 * they never construct `OrchestratorAgent` themselves.
 */

import type { IAuditWriter } from './types-permissions.js';
import { OrchestratorAgent, type OrchestratorDeps } from './orchestrator-agent.js';

/**
 * Minimal runner shape consumers depend on. Returned by `createAgentRunner`
 * so api-gateway never sees the `OrchestratorAgent` class.
 */
export interface AgentRunner {
  readonly sessionId: string;
  handleMessage(
    message: string,
    dashboardId?: string,
    signal?: AbortSignal,
  ): Promise<string>;
  consumeConversationActions(): ReturnType<OrchestratorAgent['consumeConversationActions']>;
  consumeNavigate(): string | undefined;
}

/**
 * Deps for constructing an agent runner. Mirrors `OrchestratorDeps` —
 * the factory passes them through verbatim. The only thing it adds is
 * the audit-writer bridge.
 */
export type CreateAgentRunnerDeps = OrchestratorDeps;

/**
 * Construct a fully-wired agent runner.
 *
 * Audit bridge (one line, the whole point of T1.5 wave 1 leftover): when
 * a structured `IAuditWriter` is in deps, install a slim
 * `auditEntryWriter` that adapts `.log(entry)` into the
 * `(entry) => Promise<void>` shape handlers consume via
 * `ctx.auditWriter?.(entry)`. Without this, agent-tool mutations emit
 * no audit rows.
 */
export function createAgentRunner(
  deps: CreateAgentRunnerDeps,
  sessionId?: string,
): AgentRunner {
  const bridged: OrchestratorDeps = bridgeAuditWriter(deps);
  return new OrchestratorAgent(bridged, sessionId);
}

function bridgeAuditWriter(deps: OrchestratorDeps): OrchestratorDeps {
  // Caller-supplied bridge wins (lets tests inject directly).
  if (deps.auditEntryWriter || !deps.auditWriter) return deps;
  const writer: IAuditWriter = deps.auditWriter;
  return {
    ...deps,
    auditEntryWriter: (entry) => writer.log(entry),
  };
}
