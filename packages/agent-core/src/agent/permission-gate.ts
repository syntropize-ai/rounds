/**
 * Permission gate (Wave 7). Runs before every non-terminal tool dispatch in
 * ReActLoop. Three layers — the first one that denies wins:
 *
 *   1. allowedTools ceiling   — agent type's capability list (already
 *                              enforced in orchestrator-agent.ts pre-Wave-7;
 *                              this layer is here so the gate owns the full
 *                              decision in one place).
 *   2. permissionMode         — the AgentDef's behavior mode (read_only,
 *                              propose_only, etc).
 *   3. RBAC (TOOL_PERMS)      — the caller's RBAC on (action, scope) pair.
 *
 * The gate returns a `PermissionGateResult`. On `ok: false`, the ReActLoop
 * synthesizes a `permission denied: <action> on <scope>` observation — per
 * §D3, never an exception.
 */

import { createLogger } from '@agentic-obs/common/logging';
import type { AgentDefinition } from './agent-definition.js';
import type { AgentToolName } from './agent-types.js';
import type { ActionContext } from './orchestrator-action-handlers.js';
import type { PermissionGateResult } from './types-permissions.js';
import { buildToolEvaluator } from './tool-permissions.js';

const log = createLogger('permission-gate');

/**
 * Actions that short-circuit the ReActLoop — they don't dispatch to
 * executeAction and therefore never hit the gate. Listed here for
 * documentation; the loop already handles them before calling us.
 */
const TERMINAL = new Set(['ask_user']);

/**
 * Actions that are mutations in the artifact sense. `permissionMode` only
 * gates mutations — reads always pass Layer 2 regardless of mode.
 * Synced with the MUTATION_ACTIONS list in orchestrator-agent.ts.
 */
const MUTATION_ACTIONS: ReadonlySet<string> = new Set([
  'dashboard_create', 'dashboard_add_panels', 'dashboard_remove_panels',
  'dashboard_modify_panel', 'dashboard_rearrange', 'dashboard_add_variable',
  'dashboard_set_title',
  'folder_create',
  'investigation_create', 'investigation_add_section', 'investigation_complete',
  // alert_rule_write covers create / update / delete via the `op` discriminator
  'alert_rule_write',
  // Wave 2 step 1 — moves a resource into a shared folder
  'resource_promote',
]);

/**
 * Run the three-layer check for a single tool call.
 *
 * NOTE: This does not throw on deny — the caller (ReActLoop) turns the result
 * into a `permission denied:` observation so the LLM can reason about the
 * denial rather than having the loop abort.
 */
export async function checkPermission(
  agentDef: AgentDefinition,
  tool: string,
  args: Record<string, unknown>,
  ctx: ActionContext,
): Promise<PermissionGateResult> {
  // Terminal actions never reach the gate; if one does, allow — the loop
  // will process it as a direct reply.
  if (TERMINAL.has(tool)) {
    return { ok: true };
  }

  // -- Layer 1: allowedTools ceiling ---------------------------------------
  if (!agentDef.allowedTools.includes(tool as AgentToolName)) {
    return {
      ok: false,
      reason: 'allowedTools',
      action: tool,
      scope: `agent:${agentDef.type}`,
    };
  }

  // -- Layer 2: permissionMode ---------------------------------------------
  const isMutation = MUTATION_ACTIONS.has(tool);
  if (isMutation) {
    const mode = agentDef.permissionMode;
    if (mode === 'read_only' || mode === 'propose_only') {
      return {
        ok: false,
        reason: 'permissionMode',
        action: tool,
        scope: `mode:${mode}`,
      };
    }
    // approval_required is a deferral path — the orchestrator wraps the
    // action in a proposal event elsewhere. We allow it past the gate so
    // the existing approval flow in orchestrator-agent.ts still runs.
  }

  // -- Layer 3: RBAC --------------------------------------------------------
  // Async builders (e.g. alert_rule_write op=update) call into the data store to
  // resolve scopes. A throw here used to be silently coerced into "scope
  // unknown → wildcard `folders:uid:*`" (fail-OPEN). Now we treat any
  // builder failure as deny — fail-closed is the only safe default for a
  // security gate.
  let evaluator: Awaited<ReturnType<typeof buildToolEvaluator>>;
  try {
    evaluator = await buildToolEvaluator(tool, args, ctx);
  } catch (err) {
    log.warn(
      { err: err instanceof Error ? err.message : String(err), tool },
      'permission-gate: evaluator builder threw — denying',
    );
    return {
      ok: false,
      reason: 'rbac',
      action: tool,
      scope: 'scope-resolution-failed',
    };
  }
  if (evaluator === null) {
    // Explicitly ungated tool (e.g. navigate) — let it through.
    return { ok: true };
  }

  const allowed = await ctx.accessControl.evaluate(ctx.identity, evaluator);
  if (allowed) return { ok: true };

  // Render the evaluator for the observation. `evaluator.string()` produces
  // e.g. `dashboards:create on folders:uid:prod` — we split on " on " to
  // extract the two halves; fall back to the whole string if the shape
  // doesn't match (composite evaluators).
  const rendered = evaluator.string();
  const onIdx = rendered.indexOf(' on ');
  const action =
    onIdx > 0 ? rendered.slice(0, onIdx).trim() : rendered.trim();
  const scope = onIdx > 0 ? rendered.slice(onIdx + 4).trim() : '';
  return {
    ok: false,
    reason: 'rbac',
    action,
    scope,
  };
}

/**
 * Human-readable observation text returned to the LLM when a call is denied.
 * The `permission denied:` prefix is load-bearing — the D8 prompt principle
 * instructs the model to recognize it.
 */
export function denialObservation(result: PermissionGateResult): string {
  const action = result.action ?? 'unknown';
  const scope = result.scope ?? '*';
  return `permission denied: ${action} on ${scope}`;
}
