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
 *   - No PromQL parsing anywhere. Datasource UID → scope; that's it (§D14).
 */

import type { Evaluator } from '@agentic-obs/common';
import { ac } from '@agentic-obs/common';
import type { ActionContext } from './orchestrator-action-handlers.js';
import type { ToolPermissionBuilder } from './types-permissions.js';

/**
 * Resolve the datasource UID for a source-agnostic metrics / logs / changes
 * tool call. The LLM is now required to pass `sourceId` (see orchestrator
 * system prompt — "Datasource discovery first"); we still accept the older
 * `datasourceId` / `datasourceUid` aliases for leniency. When nothing
 * resolves we scope to `datasources:uid:*` so the gate still runs — an
 * org-wide `datasources:query` grant covers this, but a per-UID grant does
 * not (fail-closed for narrow grants).
 */
function resolveDatasourceScope(args: Record<string, unknown>): string {
  if (typeof args.sourceId === 'string' && args.sourceId) {
    return `datasources:uid:${args.sourceId}`;
  }
  if (typeof args.datasourceId === 'string' && args.datasourceId) {
    return `datasources:uid:${args.datasourceId}`;
  }
  if (typeof args.datasourceUid === 'string' && args.datasourceUid) {
    return `datasources:uid:${args.datasourceUid}`;
  }
  return 'datasources:uid:*';
}

/**
 * Every tool the orchestrator (or any specialized agent) can call that
 * produces a server-side effect MUST be listed here. The list-invariant test
 * in tool-permissions.test.ts will fail if the agent registry contains a
 * non-terminal tool that isn't in this table or in UNGATED_TOOLS.
 */
export const TOOL_PERMS: Record<string, ToolPermissionBuilder> = {
  // -- Dashboard lifecycle --------------------------------------------------
  'dashboard.create': (args: Record<string, unknown>) =>
    ac.eval(
      'dashboards:create',
      `folders:uid:${String(args.folderUid ?? '*')}`,
    ),
  'dashboard.list': () => ac.eval('dashboards:read', 'dashboards:*'),
  'dashboard.add_panels': (args: Record<string, unknown>) =>
    ac.eval(
      'dashboards:write',
      `dashboards:uid:${String(args.dashboardId ?? '*')}`,
    ),
  'dashboard.remove_panels': (args: Record<string, unknown>) =>
    ac.eval(
      'dashboards:write',
      `dashboards:uid:${String(args.dashboardId ?? '*')}`,
    ),
  'dashboard.modify_panel': (args: Record<string, unknown>) =>
    ac.eval(
      'dashboards:write',
      `dashboards:uid:${String(args.dashboardId ?? '*')}`,
    ),
  'dashboard.set_title': (args: Record<string, unknown>) =>
    ac.eval(
      'dashboards:write',
      `dashboards:uid:${String(args.dashboardId ?? '*')}`,
    ),
  'dashboard.add_variable': (args: Record<string, unknown>) =>
    ac.eval(
      'dashboards:write',
      `dashboards:uid:${String(args.dashboardId ?? '*')}`,
    ),
  'dashboard.rearrange': (args: Record<string, unknown>) =>
    ac.eval(
      'dashboards:write',
      `dashboards:uid:${String(args.dashboardId ?? '*')}`,
    ),

  // -- Folder tools ---------------------------------------------------------
  'folder.create': (args: Record<string, unknown>) =>
    ac.eval(
      'folders:create',
      `folders:uid:${String(args.parentUid ?? '*')}`,
    ),
  'folder.list': () => ac.eval('folders:read', 'folders:*'),

  // -- Investigation lifecycle ---------------------------------------------
  'investigation.create': () => ac.eval('investigations:create'),
  'investigation.list': () =>
    ac.eval('investigations:read', 'investigations:*'),
  'investigation.add_section': (args: Record<string, unknown>) =>
    ac.eval(
      'investigations:write',
      `investigations:uid:${String(args.investigationId ?? '*')}`,
    ),
  'investigation.complete': (args: Record<string, unknown>) =>
    ac.eval(
      'investigations:write',
      `investigations:uid:${String(args.investigationId ?? '*')}`,
    ),

  // -- Alert rules ---------------------------------------------------------
  // create: folder-scoped
  create_alert_rule: (args: Record<string, unknown>) =>
    ac.eval(
      'alert.rules:create',
      `folders:uid:${String(args.folderUid ?? '*')}`,
    ),
  // modify/delete: async — look up the rule to derive its folderUid.
  modify_alert_rule: async (args: Record<string, unknown>, ctx: ActionContext) => {
    const ruleId = String(args.ruleId ?? '');
    const folderUid = await lookupAlertRuleFolderUid(ctx, ruleId);
    return ac.eval(
      'alert.rules:write',
      `folders:uid:${folderUid ?? '*'}`,
    );
  },
  delete_alert_rule: async (args: Record<string, unknown>, ctx: ActionContext) => {
    const ruleId = String(args.ruleId ?? '');
    const folderUid = await lookupAlertRuleFolderUid(ctx, ruleId);
    return ac.eval(
      'alert.rules:delete',
      `folders:uid:${folderUid ?? '*'}`,
    );
  },
  'alert_rule.list': () => ac.eval('alert.rules:read', 'alert.rules:*'),
  'alert_rule.history': (args: Record<string, unknown>) =>
    ac.eval(
      'alert.rules:read',
      `alert.rules:uid:${String(args.ruleId ?? '*')}`,
    ),

  // -- Metrics primitives (source-agnostic; sourceId is required) ----------
  'metrics.query': (args: Record<string, unknown>) =>
    ac.eval('datasources:query', resolveDatasourceScope(args)),
  'metrics.range_query': (args: Record<string, unknown>) =>
    ac.eval('datasources:query', resolveDatasourceScope(args)),
  'metrics.labels': (args: Record<string, unknown>) =>
    ac.eval('datasources:query', resolveDatasourceScope(args)),
  'metrics.label_values': (args: Record<string, unknown>) =>
    ac.eval('datasources:query', resolveDatasourceScope(args)),
  'metrics.series': (args: Record<string, unknown>) =>
    ac.eval('datasources:query', resolveDatasourceScope(args)),
  'metrics.metadata': (args: Record<string, unknown>) =>
    ac.eval('datasources:query', resolveDatasourceScope(args)),
  'metrics.metric_names': (args: Record<string, unknown>) =>
    ac.eval('datasources:query', resolveDatasourceScope(args)),
  'metrics.validate': (args: Record<string, unknown>) =>
    ac.eval('datasources:query', resolveDatasourceScope(args)),

  // -- Logs primitives (source-agnostic; sourceId is required) -------------
  'logs.query': (args: Record<string, unknown>) =>
    ac.eval('datasources:query', resolveDatasourceScope(args)),
  'logs.labels': (args: Record<string, unknown>) =>
    ac.eval('datasources:query', resolveDatasourceScope(args)),
  'logs.label_values': (args: Record<string, unknown>) =>
    ac.eval('datasources:query', resolveDatasourceScope(args)),

  // -- Recent change events ------------------------------------------------
  // Gated as an investigation-style read so Viewer+ roles can consult
  // deploy / incident history while diagnosing anomalies.
  'changes.list_recent': () =>
    ac.eval('investigations:read', 'investigations:*'),

  // -- Web / knowledge ------------------------------------------------------
  'web.search': () => ac.eval('chat:use'),
};

/**
 * Tools deliberately excluded from the RBAC gate.
 *
 *   - `navigate` is a pure-UI action (no server effect).
 *   - `reply` / `finish` / `ask_user` are terminal actions handled inside
 *     ReActLoop — they never reach executeAction.
 *   - `llm.complete` is an internal call from specialized agents that don't
 *     hit a user-visible resource; handlers that use it still enforce their
 *     own scoped checks.
 *   - `verifier.run` is a verification-only read that runs on artifacts
 *     already fetched by the enclosing flow; caller already passed the
 *     relevant per-artifact check.
 */
export const UNGATED_TOOLS: ReadonlySet<string> = new Set([
  'navigate',
  'reply',
  'finish',
  'ask_user',
  'llm.complete',
  'verifier.run',
  // Discovery is always allowed — the caller needs to see what's configured
  // BEFORE they can form a gated call. This is a read of the in-process
  // registry; no backend side effect.
  'datasources.list',
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
  if (!ruleId || !ctx.alertRuleStore.findById) return undefined;
  try {
    const rule = (await ctx.alertRuleStore.findById(ruleId)) as
      | Record<string, unknown>
      | undefined;
    if (!rule) return undefined;
    const folderUid =
      (rule.folderUid as string | undefined) ??
      (rule.folder_uid as string | undefined) ??
      ((rule.labels as Record<string, string> | undefined)?.folderUid);
    return folderUid;
  } catch {
    return undefined;
  }
}
