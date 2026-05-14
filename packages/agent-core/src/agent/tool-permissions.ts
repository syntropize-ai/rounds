/**
 * TOOL_PERMS — declarative map from agent tool name to the RBAC evaluator it
 * requires against the caller's identity.
 *
 * Source of truth: docs/auth-perm-design/11-agent-permissions.md §Tool
 * permission catalog. Every non-terminal, non-UI tool the orchestrator can
 * invoke appears here.
 *
 * Design notes (see §D2, §D7, §D14):
 *   - Sync builders: (args) => Evaluator            — no DB lookup needed.
 *   - Async builders: (args, ctx) => Promise<Evaluator>
 *                                                   — used for e.g. alert rule
 *                                                     modify/delete where the
 *                                                     scope is derived from
 *                                                     the rule's folderUid and
 *                                                     that requires a lookup.
 *   - Returning `null` means "this tool is not permission-gated" (only the
 *     UI-only tools below qualify). The gate treats `null` as allow.
 *   - No PromQL parsing anywhere. Connector ID → scope; that's it (§D14).
 */

import type { Evaluator } from '@agentic-obs/common';
import { ACTIONS, ac } from '@agentic-obs/common';
import type { ActionContext } from './orchestrator-action-handlers.js';
import type { ToolPermissionBuilder } from './types-permissions.js';

const DEFAULT_ALERT_RULE_FOLDER_UID = 'alerts';

/**
 * Resolve the connector ID for a source-agnostic metrics / logs / changes
 * tool call. The LLM is now required to pass `sourceId` (see orchestrator
 * system prompt — "Connector discovery first"); we still accept the older
 * `datasourceId` / `datasourceUid` aliases for leniency. When nothing
 * resolves we scope to `connectors:id:*` so the gate still runs — an
 * org-wide `connectors:query` grant covers this, but a per-ID grant does
 * not (fail-closed for narrow grants).
 */
function resolveConnectorScope(args: Record<string, unknown>): string {
  if (typeof args.sourceId === 'string' && args.sourceId) {
    return `connectors:id:${args.sourceId}`;
  }
  if (typeof args.datasourceId === 'string' && args.datasourceId) {
    return `connectors:id:${args.datasourceId}`;
  }
  if (typeof args.datasourceUid === 'string' && args.datasourceUid) {
    return `connectors:id:${args.datasourceUid}`;
  }
  return 'connectors:id:*';
}

/**
 * Dashboard mutation tools no longer take `dashboardId` as a parameter — the
 * id lives on `ctx.activeDashboardId`, set by `dashboard_create` /
 * `dashboard_clone`. When the active id is missing the handler returns a
 * clear "call dashboard_create first" error and never reaches a side effect,
 * so the gate falls back to wildcard rather than minting a deny sentinel —
 * an unusable id wouldn't tighten the gate, only confuse the failure mode.
 */
function resolveDashboardScope(ctx: ActionContext): string {
  const id = ctx.activeDashboardId;
  return id ? `dashboards:uid:${id}` : 'dashboards:uid:*';
}

/**
 * Every tool the orchestrator (or any specialized agent) can call that
 * produces a server-side effect MUST be listed here. The list-invariant test
 * in tool-permissions.test.ts will fail if the agent registry contains a
 * non-terminal tool that isn't in this table or in UNGATED_TOOLS.
 */
export const TOOL_PERMS: Record<string, ToolPermissionBuilder> = {
  // -- Dashboard lifecycle --------------------------------------------------
  'dashboard_create': (args: Record<string, unknown>) =>
    ac.eval(
      'dashboards:create',
      `folders:uid:${String(args.folderUid ?? '*')}`,
    ),
  'dashboard_list': () => ac.eval('dashboards:read', 'dashboards:*'),
  // Clone is read-then-create. We mirror dashboard_create's gating — the new
  // dashboard lands in the wildcard folder (no folderUid arg today), so any
  // narrow per-folder grant must be backed by a wider create grant. The
  // source dashboard's read is gated by the per-row filter in handlers/list,
  // which the source-id lookup goes through implicitly.
  'dashboard_clone': (args: Record<string, unknown>) =>
    ac.eval(
      'dashboards:create',
      `folders:uid:${String(args.folderUid ?? '*')}`,
    ),
  'dashboard_add_panels': (_args, ctx) => ac.eval('dashboards:write', resolveDashboardScope(ctx)),
  'dashboard_remove_panels': (_args, ctx) => ac.eval('dashboards:write', resolveDashboardScope(ctx)),
  'dashboard_modify_panel': (_args, ctx) => ac.eval('dashboards:write', resolveDashboardScope(ctx)),
  'dashboard_set_title': (_args, ctx) => ac.eval('dashboards:write', resolveDashboardScope(ctx)),
  'dashboard_add_variable': (_args, ctx) => ac.eval('dashboards:write', resolveDashboardScope(ctx)),
  'dashboard_rearrange': (_args, ctx) => ac.eval('dashboards:write', resolveDashboardScope(ctx)),

  // -- Folder tools ---------------------------------------------------------
  'folder_create': (args: Record<string, unknown>) =>
    ac.eval(
      'folders:create',
      `folders:uid:${String(args.parentUid ?? '*')}`,
    ),
  'folder_list': () => ac.eval('folders:read', 'folders:*'),

  // -- Promote (Wave 2 step 1) ---------------------------------------------
  // Layer-3 gate covers ONE side of the boundary — write on the source UID.
  // The handler itself runs the second check (write on target folder) because
  // the destination is only known once `target_folder_uid` is parsed.
  'resource_promote': (args: Record<string, unknown>) => {
    const kind = args.kind === 'alert_rule' ? 'alert.rules' : 'dashboards';
    const resourceId = String(args.id ?? '*');
    return ac.eval(`${kind}:write`, `${kind}:uid:${resourceId}`);
  },

  // -- Investigation lifecycle ---------------------------------------------
  'investigation_create': () => ac.eval('investigations:create'),
  'investigation_list': () =>
    ac.eval('investigations:read', 'investigations:*'),
  'investigation_add_section': (args: Record<string, unknown>) =>
    ac.eval(
      'investigations:write',
      `investigations:uid:${String(args.investigationId ?? '*')}`,
    ),
  'investigation_complete': (args: Record<string, unknown>) =>
    ac.eval(
      'investigations:write',
      `investigations:uid:${String(args.investigationId ?? '*')}`,
    ),

  // -- Alert rules ---------------------------------------------------------
  // alert_rule_write is the unified create/update/delete tool. The op
  // discriminator decides which RBAC action to evaluate:
  //   - op=create   → alert.rules:create on folders:uid:<folderUid|alerts>
  //   - op=update   → alert.rules:write  on folders:uid:<rule's folderUid|*>
  //   - op=delete   → alert.rules:delete on folders:uid:<rule's folderUid|*>
  // create folderUid comes from the args when present; otherwise it uses the
  // default Alerts folder. update/delete need an async lookup against the store
  // to resolve the rule's folder.
  'alert_rule_write': async (args: Record<string, unknown>, ctx: ActionContext) => {
    const op = typeof args.op === 'string' ? args.op : '';
    if (op === 'create') {
      return ac.eval(
        'alert.rules:create',
        `folders:uid:${String(args.folderUid ?? DEFAULT_ALERT_RULE_FOLDER_UID)}`,
      );
    }
    if (op === 'update' || op === 'delete') {
      const ruleId = String(args.ruleId ?? '');
      const folderUid = await lookupAlertRuleFolderUid(ctx, ruleId);
      const action = op === 'update' ? 'alert.rules:write' : 'alert.rules:delete';
      return ac.eval(action, `folders:uid:${folderUid ?? '*'}`);
    }
    // Unknown op: deny via a sentinel scope no grant covers. The handler also
    // rejects this case, but the gate runs first — fail closed at the boundary.
    return ac.eval('alert.rules:write', `op:invalid:${op || 'missing'}`);
  },
  'alert_rule_list': () => ac.eval('alert.rules:read', 'alert.rules:*'),
  'alert_rule_history': (args: Record<string, unknown>) =>
    ac.eval(
      'alert.rules:read',
      `alert.rules:uid:${String(args.ruleId ?? '*')}`,
    ),

  // -- Metrics primitives (source-agnostic; sourceId is required) ----------
  'metrics_query': (args: Record<string, unknown>) =>
    ac.eval('connectors:query', resolveConnectorScope(args)),
  'metrics_range_query': (args: Record<string, unknown>) =>
    ac.eval('connectors:query', resolveConnectorScope(args)),
  // metrics_discover collapses labels / label_values / series / metadata /
  // metric_names — they all read against the same connector scope so the
  // gate is identical regardless of the `kind` discriminator.
  'metrics_discover': (args: Record<string, unknown>) =>
    ac.eval('connectors:query', resolveConnectorScope(args)),
  'metrics_validate': (args: Record<string, unknown>) =>
    ac.eval('connectors:query', resolveConnectorScope(args)),

  // -- Logs primitives (source-agnostic; sourceId is required) -------------
  'logs_query': (args: Record<string, unknown>) =>
    ac.eval('connectors:query', resolveConnectorScope(args)),
  'logs_labels': (args: Record<string, unknown>) =>
    ac.eval('connectors:query', resolveConnectorScope(args)),
  'logs_label_values': (args: Record<string, unknown>) =>
    ac.eval('connectors:query', resolveConnectorScope(args)),

  // -- Recent change events ------------------------------------------------
  // Gated as an investigation-style read so Viewer+ roles can consult
  // deploy / incident history while diagnosing anomalies.
  'changes_list_recent': () =>
    ac.eval('investigations:read', 'investigations:*'),

  // -- Kubernetes / Ops integrations --------------------------------------
  'ops_run_command': (args: Record<string, unknown>) =>
    ac.any(
      ac.eval(
        ACTIONS.OpsCommandsRun,
        `connectors:id:${String(args.connectorId ?? '*')}`,
      ),
      ac.eval(ACTIONS.InstanceConfigWrite),
    ),

  // -- Connector-model setup and settings ---------------------------------
  'connector_propose': () => ac.eval('connectors:write', 'connectors:*'),
  'connector_apply': () => ac.eval('connectors:write', 'connectors:*'),
  'connector_test': (args: Record<string, unknown>) =>
    ac.eval('connectors:write', `connectors:id:${String(args.connectorId ?? '*')}`),
  'setting_get': () => ac.eval(ACTIONS.InstanceConfigWrite),
  'setting_set': () => ac.eval(ACTIONS.InstanceConfigWrite),

  // -- Web / knowledge ------------------------------------------------------
  'web_search': () => ac.eval('chat:use'),
};

/**
 * Tools deliberately excluded from the RBAC gate.
 *
 *   - `navigate` is a pure-UI action (no server effect).
 *   - `ask_user` is the only terminal tool left after the reply/finish
 *     drop; it's handled inside ReActLoop and never reaches executeAction.
 *   - `tool_search` is a meta-tool that resolves deferred-tool schemas in
 *     the loop without touching any backend; the per-tool gate still runs
 *     when the model invokes a deferred tool.
 *   - `llm.complete` is an internal call from specialized agents that don't
 *     hit a user-visible resource; handlers that use it still enforce their
 *     own scoped checks.
 *   - `verifier.run` is a verification-only read that runs on artifacts
 *     already fetched by the enclosing flow; caller already passed the
 *     relevant per-artifact check.
 */
export const UNGATED_TOOLS: ReadonlySet<string> = new Set([
  'navigate',
  'ask_user',
  'tool_search',
  'llm.complete',
  'verifier.run',
  // Discovery is always allowed — the caller needs to see what's configured
  // BEFORE they can form a gated call. This is a read of the in-process
  // registry; no backend side effect.
  'connectors_list',
  // Suggestion, pin, unpin are session-scoped reads / in-memory writes — no
  // backend mutation. They MUST stay ungated so the agent can call them
  // before doing any RBAC-checked work.
  'connectors_suggest',
  'connectors_pin',
  'connectors_unpin',
  'connector_list',
  'connector_template_list',
  'connector_detect',
]);

/**
 * Resolve the evaluator for a tool call, or `null` if the tool is ungated.
 * The caller decides how to react to `null` (the gate treats it as allow).
 */
export async function buildToolEvaluator(
  tool: string,
  args: Record<string, unknown>,
  ctx: ActionContext,
): Promise<Evaluator | null> {
  if (UNGATED_TOOLS.has(tool)) return null;
  const builder = TOOL_PERMS[tool];
  if (!builder) {
    // An unknown tool reaching the gate is a catalog bug — fail closed.
    // We can't synthesize a reasonable scope, so use a sentinel that no
    // grant will cover.
    return ac.eval('agent:unknown_tool', `tool:${tool}`);
  }
  return Promise.resolve(builder(args, ctx));
}

// -- internals ---------------------------------------------------------------

async function lookupAlertRuleFolderUid(
  ctx: ActionContext,
  ruleId: string,
): Promise<string | undefined> {
  if (!ruleId) return undefined;
  // Prefer the dedicated repo API — `findById()` no longer surfaces
  // `folder_uid` on the AlertRule shape, so inspecting the row contents
  // would always miss the column even when it's populated. The `getFolderUid`
  // method goes straight to the SQLite column.
  // Intentionally NOT wrapped in try/catch — a lookup failure here used to
  // return undefined, which then scoped RBAC to the wildcard `folders:uid:*`.
  // That meant a transient DB blip silently widened the gate to "any folder",
  // which is fail-open. Now we let the throw propagate; the gate code in
  // permission-gate.ts treats the throw as deny-by-default.
  if (ctx.alertRuleStore.getFolderUid) {
    const folderUid = await ctx.alertRuleStore.getFolderUid(
      ctx.identity.orgId,
      ruleId,
    );
    return folderUid ?? undefined;
  }
  // Fallback for stores that don't implement getFolderUid: return undefined
  // so the gate scopes to the wildcard. This is the legacy in-memory path.
  return undefined;
}
