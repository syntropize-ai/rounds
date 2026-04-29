import { getErrorMessage } from '@agentic-obs/common';
import { createLogger } from '@agentic-obs/common/logging';
import type { DashboardSseEvent } from '@agentic-obs/common';
import type { AgentDefinition } from './agent-definition.js';
import type { AgentEvent } from './agent-events.js';
import type { ReActStep } from './react-loop.js';
import { checkPermission, denialObservation } from './permission-gate.js';
import type { ActionContext } from './orchestrator-action-handlers.js';
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
  handleDatasourcesList,
  handleDatasourcesSuggest,
  handleDatasourcesPin,
  handleDatasourcesUnpin,
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
  'dashboard.create', 'dashboard.clone',
  'dashboard.add_panels', 'dashboard.remove_panels', 'dashboard.modify_panel',
  'dashboard.rearrange', 'dashboard.add_variable', 'dashboard.set_title',
  'investigation.create', 'investigation.add_section', 'investigation.complete',
  // alert_rule.write covers create / update / delete via the `op` discriminator
  'alert_rule.write',
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
    case 'dashboard.create': return handleDashboardCreate(ctx, args);
    case 'dashboard.list': return handleDashboardList(ctx, args);
    case 'dashboard.clone': return handleDashboardClone(ctx, args);
    // Dashboard mutation primitives (dashboardId comes from args)
    case 'dashboard.add_panels': return handleDashboardAddPanels(ctx, args);
    case 'dashboard.set_title': return handleDashboardSetTitle(ctx, args);
    case 'dashboard.remove_panels': return handleDashboardRemovePanels(ctx, args);
    case 'dashboard.modify_panel': return handleDashboardModifyPanel(ctx, args);
    case 'dashboard.add_variable': return handleDashboardAddVariable(ctx, args);
    // Investigation lifecycle
    case 'investigation.create': return handleInvestigationCreate(ctx, args);
    case 'investigation.list': return handleInvestigationList(ctx, args);
    case 'investigation.add_section': return handleInvestigationAddSection(ctx, args);
    case 'investigation.complete': return handleInvestigationComplete(ctx, args);
    // Alert rules — alert_rule.write dispatches create/update/delete via `op`
    case 'alert_rule.write': return handleAlertRuleWrite(ctx, args);
    case 'alert_rule.list': return handleAlertRuleList(ctx, args);
    case 'alert_rule.history': return handleAlertRuleHistory(ctx, args);
    // Folder lifecycle (minimal — organize dashboards)
    case 'folder.create': return handleFolderCreate(ctx, args);
    case 'folder.list': return handleFolderList(ctx, args);
    // Navigation
    case 'navigate': return handleNavigate(ctx, args);
    // Datasource discovery (always allowed)
    case 'datasources.list': return handleDatasourcesList(ctx, args);
    case 'datasources.suggest': return handleDatasourcesSuggest(ctx, args);
    case 'datasources.pin': return handleDatasourcesPin(ctx, args);
    case 'datasources.unpin': return handleDatasourcesUnpin(ctx, args);
    // Source-agnostic metrics primitives — discover collapses labels /
    // label_values / series / metadata / metric_names via `kind`
    case 'metrics.query': return handleMetricsQuery(ctx, args);
    case 'metrics.range_query': return handleMetricsRangeQuery(ctx, args);
    case 'metrics.discover': return handleMetricsDiscover(ctx, args);
    case 'metrics.validate': return handleMetricsValidate(ctx, args);
    // Source-agnostic logs primitives
    case 'logs.query': return handleLogsQuery(ctx, args);
    case 'logs.labels': return handleLogsLabels(ctx, args);
    case 'logs.label_values': return handleLogsLabelValues(ctx, args);
    // Recent change events
    case 'changes.list_recent': return handleChangesListRecent(ctx, args);
    // Kubernetes / Ops integrations
    case 'ops.run_command': return handleOpsRunCommand(ctx, args);
    // Remediation plans (P4)
    case 'remediation_plan.create': return handleRemediationPlanCreate(ctx, args);
    case 'remediation_plan.create_rescue': return handleRemediationPlanCreateRescue(ctx, args);
    // Web search
    case 'web.search': return handleWebSearch(ctx, args);
    // `tool_search` is intercepted by ReActLoop before dispatch — it
    // resolves deferred-tool schemas and feeds them back as an observation
    // without round-tripping through the dispatcher. Listed here as a
    // no-op fallback so an out-of-loop caller doesn't see it as unknown.
    case 'tool_search': return null;
    default: return `Unknown action "${action}" - skipping.`;
  }
}
