import { getErrorMessage } from '@agentic-obs/common';
import { createLogger } from '@agentic-obs/common/logging';
import type { DashboardSseEvent } from '@agentic-obs/common';
import type { AgentDefinition } from './agent-definition.js';
import type { AgentEvent } from './agent-events.js';
import type { ReActStep } from './react-loop.js';
import { checkPermission, denialObservation } from './permission-gate.js';
import type { ActionContext } from './orchestrator-action-handlers.js';
import { TOOL_REGISTRY } from './tool-schema-registry.js';
import {
  handleDashboardCreate,
  handleDashboardClone,
  handleInvestigationCreate,
  handleInvestigationAddSection,
  handleInvestigationComplete,
  handleAlertRuleWrite,
  handleDashboardAddPanels,
  handleDashboardSetTitle,
  handleDashboardRemovePanels,
  handleDashboardModifyPanel,
  handleDashboardAddVariable,
  handleConnectorsList,
  handleConnectorsSuggest,
  handleConnectorsPin,
  handleConnectorsUnpin,
  handleMetricsQuery,
  handleMetricsRangeQuery,
  handleMetricsDiscover,
  handleMetricsValidate,
  handleLogsQuery,
  handleLogsLabels,
  handleLogsLabelValues,
  handleChangesListRecent,
  handleWebSearch,
  handleDashboardList,
  handleInvestigationList,
  handleAlertRuleList,
  handleAlertRuleHistory,
  handleNavigate,
  handleFolderCreate,
  handleFolderList,
  handleOpsRunCommand,
  handleRemediationPlanCreate,
  handleRemediationPlanCreateRescue,
  handleConnectorList,
  handleConnectorTemplateList,
  handleConnectorDetect,
  handleConnectorPropose,
  handleConnectorApply,
  handleConnectorTest,
  handleSettingGet,
  handleSettingSet,
} from './orchestrator-action-handlers.js';
import type { ToolAuditReporter } from './orchestrator-audit-reporter.js';

const log = createLogger('orchestrator');

/**
 * Mutations that still trigger the legacy approval / propose-only output
 * channel. The new three-layer gate handles read_only + propose_only as
 * denials (Layer 2); `approval_required` is preserved here because it is a
 * deferral (emit a proposal, don't execute) rather than a denial.
 */
const MUTATION_ACTIONS = [
  'dashboard_create', 'dashboard_clone',
  'dashboard_add_panels', 'dashboard_remove_panels', 'dashboard_modify_panel',
  'dashboard_rearrange', 'dashboard_add_variable', 'dashboard_set_title',
  'investigation_create', 'investigation_add_section', 'investigation_complete',
  // alert_rule_write covers create / update / delete via the `op` discriminator
  'alert_rule_write',
] as const;

export interface PermissionWrappedActionRunnerDeps {
  agentDef: AgentDefinition;
  auditReporter: ToolAuditReporter;
  sendEvent: (event: DashboardSseEvent) => void;
  emitAgentEvent(event: AgentEvent): void;
  makeAgentEvent(type: AgentEvent['type'], metadata?: Record<string, unknown>): AgentEvent;
}

export class PermissionWrappedActionRunner {
  constructor(private readonly deps: PermissionWrappedActionRunnerDeps) {}

  async execute(step: ReActStep, ctx: ActionContext): Promise<string | null> {
    const { action, args } = step;

    // --- Three-layer permission gate (Wave 7) ---
    // Layer 1 (allowedTools) + Layer 2 (permissionMode read_only/propose_only)
    // + Layer 3 (RBAC via TOOL_PERMS) are all handled inside checkPermission.
    // On deny, emit audit + synthesize a `permission denied:` observation.
    const gateResult = await checkPermission(this.deps.agentDef, action, args, ctx);
    if (!gateResult.ok) {
      log.warn(`[Orchestrator] tool "${action}" denied by ${gateResult.reason}`);
      this.deps.emitAgentEvent(this.deps.makeAgentEvent('agent.tool_blocked', {
        tool: action,
        reason: gateResult.reason,
        deniedAction: gateResult.action,
        deniedScope: gateResult.scope,
      }));
      await this.deps.auditReporter.writeToolAudit('denied', action, args, gateResult);
      const observation = denialObservation(gateResult);
      this.deps.sendEvent({
        type: 'tool_result',
        tool: action,
        summary: observation,
        success: false,
      });
      return observation;
    }

    // approval_required mutations: propagate the legacy approval side-channel
    // (the gate already passed — Layer 2 intentionally lets this mode through).
    if (isMutationAction(action) && this.deps.agentDef.permissionMode === 'approval_required') {
      log.info(`[Orchestrator] mutation "${action}" requires approval — emitting proposal`);
      this.deps.emitAgentEvent(this.deps.makeAgentEvent('agent.artifact_proposed', { tool: action, args }));
      this.deps.sendEvent({
        type: 'approval_required',
        tool: action,
        args,
        displayText: `Action "${action}" requires approval before execution.`,
      });
      return `Action "${action}" requires approval. A proposal has been submitted.`;
    }

    // --- Required-arg validation (schema-driven) ---
    // Detect missing required args before dispatching to the handler so we can
    // tell the user what's missing instead of letting the handler fail and the
    // model retry blindly. alert_rule_write op=create intentionally does not
    // require folderUid; the handler owns the default Alerts folder rule.
    const missingObs = await checkRequiredArgs(action, args, ctx);
    if (missingObs !== null) {
      this.deps.sendEvent({
        type: 'tool_result',
        tool: action,
        summary: missingObs,
        success: false,
      });
      return missingObs;
    }

    // --- Emit tool_called event + audit allow path (rate-limited) ---
    this.deps.emitAgentEvent(this.deps.makeAgentEvent('agent.tool_called', { tool: action }));
    await this.deps.auditReporter.writeToolAudit('allow', action, args, gateResult);

    try {
      return await dispatchAction(action, args, ctx);
    } catch (err) {
      const observationText = `Action "${action}" failed: ${getErrorMessage(err)}. Do NOT retry — end your turn with a plain-text reply that tells the user what went wrong.`;
      this.deps.sendEvent({
        type: 'tool_result',
        tool: action,
        summary: observationText,
        success: false,
      });
      this.deps.emitAgentEvent(this.deps.makeAgentEvent('agent.tool_completed', {
        tool: action,
        success: false,
        error: getErrorMessage(err),
      }));
      return observationText;
    }
  }
}

function isMutationAction(action: string): boolean {
  return (MUTATION_ACTIONS as readonly string[]).includes(action);
}

async function dispatchAction(
  action: string,
  args: Record<string, unknown>,
  ctx: ActionContext,
): Promise<string | null> {
  switch (action) {
    // Dashboard lifecycle
    case 'dashboard_create': return handleDashboardCreate(ctx, args);
    case 'dashboard_list': return handleDashboardList(ctx, args);
    case 'dashboard_clone': return handleDashboardClone(ctx, args);
    // Dashboard mutation primitives (dashboardId comes from args)
    case 'dashboard_add_panels': return handleDashboardAddPanels(ctx, args);
    case 'dashboard_set_title': return handleDashboardSetTitle(ctx, args);
    case 'dashboard_remove_panels': return handleDashboardRemovePanels(ctx, args);
    case 'dashboard_modify_panel': return handleDashboardModifyPanel(ctx, args);
    case 'dashboard_add_variable': return handleDashboardAddVariable(ctx, args);
    // Investigation lifecycle
    case 'investigation_create': return handleInvestigationCreate(ctx, args);
    case 'investigation_list': return handleInvestigationList(ctx, args);
    case 'investigation_add_section': return handleInvestigationAddSection(ctx, args);
    case 'investigation_complete': return handleInvestigationComplete(ctx, args);
    // Alert rules — alert_rule_write dispatches create/update/delete via `op`
    case 'alert_rule_write': return handleAlertRuleWrite(ctx, args);
    case 'alert_rule_list': return handleAlertRuleList(ctx, args);
    case 'alert_rule_history': return handleAlertRuleHistory(ctx, args);
    // Folder lifecycle (minimal — organize dashboards)
    case 'folder_create': return handleFolderCreate(ctx, args);
    case 'folder_list': return handleFolderList(ctx, args);
    // Navigation
    case 'navigate': return handleNavigate(ctx, args);
    // Connector discovery (always allowed)
    case 'connectors_list': return handleConnectorsList(ctx, args);
    case 'connectors_suggest': return handleConnectorsSuggest(ctx, args);
    case 'connectors_pin': return handleConnectorsPin(ctx, args);
    case 'connectors_unpin': return handleConnectorsUnpin(ctx, args);
    // Source-agnostic metrics primitives — discover collapses labels /
    // label_values / series / metadata / metric_names via `kind`
    case 'metrics_query': return handleMetricsQuery(ctx, args);
    case 'metrics_range_query': return handleMetricsRangeQuery(ctx, args);
    case 'metrics_discover': return handleMetricsDiscover(ctx, args);
    case 'metrics_validate': return handleMetricsValidate(ctx, args);
    // Source-agnostic logs primitives
    case 'logs_query': return handleLogsQuery(ctx, args);
    case 'logs_labels': return handleLogsLabels(ctx, args);
    case 'logs_label_values': return handleLogsLabelValues(ctx, args);
    // Recent change events
    case 'changes_list_recent': return handleChangesListRecent(ctx, args);
    // Kubernetes / Ops integrations
    case 'ops_run_command': return handleOpsRunCommand(ctx, args);
    // Remediation plans (P4)
    case 'remediation_plan_create': return handleRemediationPlanCreate(ctx, args);
    case 'remediation_plan_create_rescue': return handleRemediationPlanCreateRescue(ctx, args);
    // Connector-model configuration tools.
    case 'connector_list': return handleConnectorList(ctx, args);
    case 'connector_template_list': return handleConnectorTemplateList(ctx, args);
    case 'connector_detect': return handleConnectorDetect(ctx, args);
    case 'connector_propose': return handleConnectorPropose(ctx, args);
    case 'connector_apply': return handleConnectorApply(ctx, args);
    case 'connector_test': return handleConnectorTest(ctx, args);
    case 'setting_get': return handleSettingGet(ctx, args);
    case 'setting_set': return handleSettingSet(ctx, args);
    // Web search
    case 'web_search': return handleWebSearch(ctx, args);
    // `tool_search` is intercepted by ReActLoop before dispatch — it
    // resolves deferred-tool schemas and feeds them back as an observation
    // without round-tripping through the dispatcher. Listed here as a
    // no-op fallback so an out-of-loop caller doesn't see it as unknown.
    case 'tool_search': return null;
    default: return `Unknown action "${action}" - skipping.`;
  }
}

/**
 * Schema-driven required-arg validation. Returns null when the call is fine
 * (or after a silent auto-fill). Returns a clarifying observation when an
 * argument is missing — the runner surfaces that to the user as a tool_result
 * and short-circuits dispatch so the model doesn't retry blindly.
 *
 * Special case: `alert_rule_write` op=create can omit `folderUid`; the handler
 * will place the rule in the org's default Alerts folder. A caller can still
 * pass a concrete `folderUid` when the user explicitly asks for one.
 */
async function checkRequiredArgs(
  action: string,
  args: Record<string, unknown>,
  _ctx: ActionContext,
): Promise<string | null> {
  const entry = TOOL_REGISTRY[action];
  const required = entry?.schema.input_schema?.required ?? [];
  const missing = required.filter((name) => {
    const v = args[name];
    if (v === undefined || v === null) return true;
    if (typeof v === 'string' && v.trim() === '') return true;
    return false;
  });
  if (missing.length === 0) return null;
  return (
    `Cannot run ${action}: missing required argument${missing.length > 1 ? 's' : ''} ${missing.map((n) => `"${n}"`).join(', ')}. ` +
    `Ask the user for the missing value (use ask_user) instead of guessing.`
  );
}
