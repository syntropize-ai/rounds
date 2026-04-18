import { randomUUID } from 'node:crypto'
import { AuditAction, createLogger, getErrorMessage } from '@agentic-obs/common'
import type {
  DashboardSseEvent,
  DashboardAction,
  Identity,
} from '@agentic-obs/common'
import type {
  IDashboardAgentStore,
  IConversationStore,
  IInvestigationReportStore,
  IInvestigationStore,
  IAlertRuleStore,
  DatasourceConfig,
} from './types.js'
import type { IMetricsAdapter, IWebSearchAdapter } from '../adapters/index.js'
import type { LLMGateway } from '@agentic-obs/llm-gateway'
import { ActionExecutor } from './action-executor.js'
import { AlertRuleAgent } from './alert-rule-agent.js'
import { ReActLoop } from './react-loop.js'
import type { ReActStep } from './react-loop.js'
import { agentRegistry } from './agent-registry.js'
import type { AgentDefinition } from './agent-definition.js'
import type { AgentType } from './agent-types.js'
import type { AgentEvent } from './agent-events.js'
import { checkPermission, denialObservation } from './permission-gate.js'
import type {
  IAccessControlService,
  IAuditWriter,
  PermissionGateResult,
} from './types-permissions.js'
import type { AlertRuleSummary } from './orchestrator-alert-helpers.js'
import {
  getStructuredAlertRuleContext,
  parseAlertFollowUpAction,
  composeAlertFollowUpReply,
} from './orchestrator-alert-helpers.js'
import { buildSystemPrompt } from './orchestrator-prompt.js'
import type { ActionContext } from './orchestrator-action-handlers.js'
import {
  handleDashboardCreate,
  handleInvestigationCreate,
  handleInvestigationAddSection,
  handleInvestigationComplete,
  handleCreateAlertRule,
  handleModifyAlertRule,
  handleDeleteAlertRule,
  handleDashboardAddPanels,
  handleDashboardSetTitle,
  handleDashboardRemovePanels,
  handleDashboardModifyPanel,
  handleDashboardAddVariable,
  handlePrometheusQuery,
  handlePrometheusRangeQuery,
  handlePrometheusLabels,
  handlePrometheusLabelValues,
  handlePrometheusSeries,
  handlePrometheusMetadata,
  handlePrometheusMetricNames,
  handlePrometheusValidate,
  handleWebSearch,
  handleDashboardList,
  handleInvestigationList,
  handleAlertRuleList,
  handleAlertRuleHistory,
  handleNavigate,
} from './orchestrator-action-handlers.js'

export interface OrchestratorDeps {
  gateway: LLMGateway
  model: string
  store: IDashboardAgentStore
  conversationStore: IConversationStore
  investigationReportStore: IInvestigationReportStore
  investigationStore?: IInvestigationStore
  alertRuleStore: IAlertRuleStore
  metricsAdapter?: IMetricsAdapter
  webSearchAdapter?: IWebSearchAdapter
  allDatasources?: DatasourceConfig[]
  sendEvent: (event: DashboardSseEvent) => void
  timeRange?: { start: string; end: string; timezone?: string }
  maxTokenBudget?: number
  /** LLM-generated summary of earlier conversation turns (from context compaction) */
  conversationSummary?: string
  /**
   * Wave 7 — the caller's bound identity. Required. The agent is the user's
   * hands; running without one is undefined by design (see §D1, §D4).
   */
  identity: Identity
  /** Access-control surface for the per-call gate and list-filter. */
  accessControl: IAccessControlService
  /**
   * Audit-log writer. Optional (tests can omit) but production callers MUST
   * pass one — every gated dispatch writes `agent.tool_called` or
   * `agent.tool_denied` per §D9.
   */
  auditWriter?: IAuditWriter
  /**
   * Which specialized agent this run uses. Defaults to `orchestrator`. Pick a
   * narrower type to tighten the allowedTools ceiling (Layer 1).
   */
  agentType?: AgentType
  /**
   * Operator-configured escalation contact displayed to the LLM as a factual
   * template variable. See §D8, §D13. Falls back to process.env when unset.
   */
  permissionEscalationContact?: string
}

/**
 * Mutations that still trigger the legacy approval / propose-only output
 * channel. The new three-layer gate handles read_only + propose_only as
 * denials (Layer 2); `approval_required` is preserved here because it is a
 * deferral (emit a proposal, don't execute) rather than a denial.
 */
const MUTATION_ACTIONS = [
  'dashboard.create', 'dashboard.add_panels', 'dashboard.remove_panels', 'dashboard.modify_panel',
  'dashboard.rearrange', 'dashboard.add_variable', 'dashboard.set_title',
  'investigation.create', 'investigation.add_section', 'investigation.complete',
  'create_alert_rule', 'modify_alert_rule', 'delete_alert_rule',
] as const;

function isMutationAction(action: string): boolean {
  return (MUTATION_ACTIONS as readonly string[]).includes(action);
}

const log = createLogger('orchestrator')

/** Per-(userId, tool) rate-limit window for `agent.tool_called` audit rows. */
const ALLOW_AUDIT_COOLDOWN_MS = 60_000

export class OrchestratorAgent {
  static readonly definition = agentRegistry.get('orchestrator')!;

  private readonly actionExecutor: ActionExecutor
  private readonly alertRuleAgent: AlertRuleAgent
  private readonly reactLoop: ReActLoop
  private readonly agentDef: AgentDefinition
  private pendingConversationActions: DashboardAction[] = []
  private pendingNavigateTo?: string
  private readonly allowAuditAt = new Map<string, number>()
  readonly sessionId: string

  constructor(private deps: OrchestratorDeps, sessionId?: string) {
    this.sessionId = sessionId ?? randomUUID()
    this.actionExecutor = new ActionExecutor(deps.store, deps.sendEvent)

    const type = deps.agentType ?? 'orchestrator'
    const def = agentRegistry.get(type)
    if (!def) {
      throw new Error(`OrchestratorAgent: unknown agent type "${type}"`)
    }
    this.agentDef = def

    this.alertRuleAgent = new AlertRuleAgent({
      gateway: deps.gateway,
      model: deps.model,
      metrics: deps.metricsAdapter,
    })

    this.reactLoop = new ReActLoop({
      gateway: deps.gateway,
      model: deps.model,
      sendEvent: deps.sendEvent,
      identity: deps.identity,
      accessControl: deps.accessControl,
      maxTokenBudget: deps.maxTokenBudget,
      conversationSummary: deps.conversationSummary,
    })

    log.info(`[Orchestrator] init: agentType=${type}, metricsAdapter=${deps.metricsAdapter ? 'SET' : 'UNSET'}`)
  }

  private emitAgentEvent(event: AgentEvent): void {
    this.deps.sendEvent({ type: 'agent_event', event });
  }

  private makeAgentEvent(
    type: AgentEvent['type'],
    metadata?: Record<string, unknown>,
  ): AgentEvent {
    return {
      type,
      agentType: this.agentDef.type,
      timestamp: new Date().toISOString(),
      ...(metadata ? { metadata } : {}),
    };
  }

  /**
   * Persist an audit row for a gated tool call. Allow-path is rate-limited to
   * one row per (identity.userId, tool) per 60s (§D9). Deny-path always writes.
   * Fire-and-forget; writer failures never block the loop.
   */
  private async writeToolAudit(
    path: 'allow' | 'denied',
    tool: string,
    args: Record<string, unknown>,
    gateResult: PermissionGateResult,
  ): Promise<void> {
    const writer = this.deps.auditWriter;
    if (!writer) return;

    // Allow-path rate limit — key by principal+tool.
    if (path === 'allow') {
      const key = `${this.deps.identity.userId}:${tool}`;
      const last = this.allowAuditAt.get(key) ?? 0;
      const now = Date.now();
      if (now - last < ALLOW_AUDIT_COOLDOWN_MS) return;
      this.allowAuditAt.set(key, now);
    }

    const targetType = inferTargetType(tool);
    const targetId = inferTargetId(tool, args);
    const action = path === 'allow'
      ? AuditAction.AgentToolCalled
      : AuditAction.AgentToolDenied;
    const outcome: 'success' | 'failure' =
      path === 'allow' ? 'success' : 'failure';

    // Truncate args summary — chat payloads can be large and we never need
    // them verbatim in the audit log.
    const argsSummary = summarizeArgs(args);

    await writer.log({
      action,
      actorType: this.deps.identity.serviceAccountId ? 'service_account' : 'user',
      actorId: this.deps.identity.serviceAccountId ?? this.deps.identity.userId,
      orgId: this.deps.identity.orgId,
      targetType,
      targetId: targetId ?? null,
      outcome,
      metadata: {
        agent_type: this.agentDef.type,
        tool,
        required_action: gateResult.action ?? null,
        required_scope: gateResult.scope ?? null,
        denied_by: path === 'denied' ? gateResult.reason ?? null : null,
        args_summary: argsSummary,
      },
    }).catch((err) => {
      log.warn(
        { err: err instanceof Error ? err.message : err, tool, path },
        'agent audit write failed',
      );
    });
  }

  consumeConversationActions(): DashboardAction[] {
    const actions = [...this.pendingConversationActions]
    this.pendingConversationActions = []
    return actions
  }

  consumeNavigate(): string | undefined {
    const navigateTo = this.pendingNavigateTo
    this.pendingNavigateTo = undefined
    return navigateTo
  }

  /**
   * Handle a user message. When dashboardId is provided, the agent is scoped
   * to that dashboard (backward compat). When omitted, the agent operates in
   * session mode — it can create dashboards/investigations via tools.
   */
  async handleMessage(message: string, dashboardId?: string): Promise<string> {
    this.emitAgentEvent(this.makeAgentEvent('agent.started', { dashboardId, message }));
    this.pendingConversationActions = []
    this.pendingNavigateTo = undefined

    // Resolve dashboard context (optional in session mode)
    const dashboard = dashboardId
      ? await this.deps.store.findById(dashboardId)
      : undefined
    if (dashboardId && !dashboard) {
      this.emitAgentEvent(this.makeAgentEvent('agent.failed', { reason: 'Dashboard not found' }));
      throw new Error(`Dashboard ${dashboardId} not found`)
    }

    const conversationKey = dashboardId ?? this.sessionId
    const history = await this.deps.conversationStore.getMessages(conversationKey)

    // Fetch existing alert rules so LLM can reference them for modify/delete
    let alertRules: AlertRuleSummary[] = []
    if (this.deps.alertRuleStore.findAll) {
      try {
        const result = await this.deps.alertRuleStore.findAll()
        alertRules = (Array.isArray(result) ? result : (result as { list: unknown[] }).list ?? []) as typeof alertRules
      } catch { /* ignore */ }
    }

    const activeAlertRule = getStructuredAlertRuleContext(history, alertRules)
    const directFollowUpAction = parseAlertFollowUpAction(message, activeAlertRule)
    if (directFollowUpAction) {
      const result = await this.executeAction(directFollowUpAction)
      const finalReply = result
        ? await composeAlertFollowUpReply(this.deps.gateway, this.deps.model, message, directFollowUpAction, result)
        : ''
      if (finalReply) {
        this.deps.sendEvent({ type: 'reply', content: finalReply })
      }
      this.emitAgentEvent(this.makeAgentEvent('agent.completed', { dashboardId, mode: 'structured_alert_followup' }));
      return finalReply
    }

    const systemPrompt = buildSystemPrompt(dashboard ?? null, history, alertRules, activeAlertRule, this.deps.allDatasources ?? [], {
      hasPrometheus: !!this.deps.metricsAdapter,
      timeRange: this.deps.timeRange ? { start: this.deps.timeRange.start, end: this.deps.timeRange.end } : undefined,
      identity: this.deps.identity,
      permissionEscalationContact: this.deps.permissionEscalationContact,
    })

    try {
      const result = await this.reactLoop.runLoop(
        systemPrompt,
        message,
        (step) => this.executeAction(step, message),
      )
      this.emitAgentEvent(this.makeAgentEvent('agent.completed', { dashboardId }));
      return result;
    }
    catch (err) {
      this.emitAgentEvent(this.makeAgentEvent('agent.failed', {
        dashboardId,
        error: getErrorMessage(err),
      }));
      throw err;
    }
  }

  private buildActionContext(): ActionContext {
    return {
      gateway: this.deps.gateway,
      model: this.deps.model,
      store: this.deps.store,
      investigationReportStore: this.deps.investigationReportStore,
      investigationStore: this.deps.investigationStore,
      alertRuleStore: this.deps.alertRuleStore,
      metricsAdapter: this.deps.metricsAdapter,
      webSearchAdapter: this.deps.webSearchAdapter,
      allDatasources: this.deps.allDatasources,
      sendEvent: this.deps.sendEvent,
      sessionId: this.sessionId,
      identity: this.deps.identity,
      accessControl: this.deps.accessControl,
      actionExecutor: this.actionExecutor,
      alertRuleAgent: this.alertRuleAgent,
      emitAgentEvent: (event) => this.emitAgentEvent(event),
      makeAgentEvent: (type, metadata) => this.makeAgentEvent(type, metadata),
      pushConversationAction: (action) => this.pendingConversationActions.push(action),
      setNavigateTo: (path) => { this.pendingNavigateTo = path },
    }
  }

  private async executeAction(step: ReActStep, _userMessage = ''): Promise<string | null> {
    const { action, args } = step
    const agentDef = this.agentDef;
    const ctx = this.buildActionContext()

    // --- Three-layer permission gate (Wave 7) ---
    // Layer 1 (allowedTools) + Layer 2 (permissionMode read_only/propose_only)
    // + Layer 3 (RBAC via TOOL_PERMS) are all handled inside checkPermission.
    // On deny, emit audit + synthesize a `permission denied:` observation.
    const gateResult = await checkPermission(agentDef, action, args, ctx);
    if (!gateResult.ok) {
      log.warn(`[Orchestrator] tool "${action}" denied by ${gateResult.reason}`);
      this.emitAgentEvent(this.makeAgentEvent('agent.tool_blocked', {
        tool: action,
        reason: gateResult.reason,
        deniedAction: gateResult.action,
        deniedScope: gateResult.scope,
      }));
      await this.writeToolAudit('denied', action, args, gateResult);
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
    if (isMutationAction(action) && agentDef.permissionMode === 'approval_required') {
      log.info(`[Orchestrator] mutation "${action}" requires approval — emitting proposal`);
      this.emitAgentEvent(this.makeAgentEvent('agent.artifact_proposed', { tool: action, args }));
      this.deps.sendEvent({
        type: 'approval_required',
        tool: action,
        args,
        displayText: `Action "${action}" requires approval before execution.`,
      });
      return `Action "${action}" requires approval. A proposal has been submitted.`;
    }

    // --- Emit tool_called event + audit allow path (rate-limited) ---
    this.emitAgentEvent(this.makeAgentEvent('agent.tool_called', { tool: action }));
    await this.writeToolAudit('allow', action, args, gateResult);

    try {
      switch (action) {
        // Dashboard lifecycle
        case 'dashboard.create': return handleDashboardCreate(ctx, args)
        case 'dashboard.list': return handleDashboardList(ctx, args)
        // Dashboard mutation primitives (dashboardId comes from args)
        case 'dashboard.add_panels': return handleDashboardAddPanels(ctx, args)
        case 'dashboard.set_title': return handleDashboardSetTitle(ctx, args)
        case 'dashboard.remove_panels': return handleDashboardRemovePanels(ctx, args)
        case 'dashboard.modify_panel': return handleDashboardModifyPanel(ctx, args)
        case 'dashboard.add_variable': return handleDashboardAddVariable(ctx, args)
        // Investigation lifecycle
        case 'investigation.create': return handleInvestigationCreate(ctx, args)
        case 'investigation.list': return handleInvestigationList(ctx, args)
        case 'investigation.add_section': return handleInvestigationAddSection(ctx, args)
        case 'investigation.complete': return handleInvestigationComplete(ctx, args)
        // Alert rules
        case 'create_alert_rule': return handleCreateAlertRule(ctx, args)
        case 'modify_alert_rule': return handleModifyAlertRule(ctx, args)
        case 'delete_alert_rule': return handleDeleteAlertRule(ctx, args)
        case 'alert_rule.list': return handleAlertRuleList(ctx, args)
        case 'alert_rule.history': return handleAlertRuleHistory(ctx, args)
        // Navigation
        case 'navigate': return handleNavigate(ctx, args)
        // Prometheus primitives
        case 'prometheus.query': return handlePrometheusQuery(ctx, args)
        case 'prometheus.range_query': return handlePrometheusRangeQuery(ctx, args)
        case 'prometheus.labels': return handlePrometheusLabels(ctx, args)
        case 'prometheus.label_values': return handlePrometheusLabelValues(ctx, args)
        case 'prometheus.series': return handlePrometheusSeries(ctx, args)
        case 'prometheus.metadata': return handlePrometheusMetadata(ctx, args)
        case 'prometheus.metric_names': return handlePrometheusMetricNames(ctx, args)
        case 'prometheus.validate': return handlePrometheusValidate(ctx, args)
        // Web search
        case 'web.search': return handleWebSearch(ctx, args)
        // 'finish' is handled as a terminal action in ReActLoop
        case 'finish': return null
        default: return `Unknown action "${action}" - skipping.`
      }
    }
    catch (err) {
      const observationText = `Action "${action}" failed: ${getErrorMessage(err)}. Do NOT retry — use "reply" to inform the user.`
      this.deps.sendEvent({
        type: 'tool_result',
        tool: action,
        summary: observationText,
        success: false,
      })
      this.emitAgentEvent(this.makeAgentEvent('agent.tool_completed', {
        tool: action,
        success: false,
        error: getErrorMessage(err),
      }));
      return observationText
    }
  }
}

// --- audit metadata helpers ------------------------------------------------

function inferTargetType(tool: string): string | null {
  if (tool.startsWith('dashboard.')) return 'dashboard';
  if (tool.startsWith('folder.')) return 'folder';
  if (tool.startsWith('investigation.')) return 'investigation';
  if (tool.startsWith('prometheus.')) return 'datasource';
  if (tool.startsWith('alert_rule.') || tool === 'create_alert_rule' || tool === 'modify_alert_rule' || tool === 'delete_alert_rule') {
    return 'alert_rule';
  }
  if (tool === 'web.search') return 'web_search';
  return null;
}

function inferTargetId(tool: string, args: Record<string, unknown>): string | null {
  if (tool.startsWith('dashboard.')) return pickString(args.dashboardId);
  if (tool.startsWith('investigation.')) return pickString(args.investigationId);
  if (tool.startsWith('folder.')) return pickString(args.folderUid ?? args.parentUid);
  if (tool.startsWith('prometheus.')) return pickString(args.datasourceId ?? args.datasourceUid);
  if (tool === 'create_alert_rule') return pickString(args.folderUid);
  if (tool === 'modify_alert_rule' || tool === 'delete_alert_rule' || tool === 'alert_rule.history') {
    return pickString(args.ruleId);
  }
  return null;
}

function pickString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function summarizeArgs(args: Record<string, unknown>): string {
  try {
    const s = JSON.stringify(args);
    return s.length <= 200 ? s : `${s.slice(0, 200)}...`;
  } catch {
    return '[unserializable args]';
  }
}
