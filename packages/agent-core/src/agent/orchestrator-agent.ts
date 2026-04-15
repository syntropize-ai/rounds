import { randomUUID } from 'node:crypto'
import { createLogger, getErrorMessage } from '@agentic-obs/common'
import type {
  DashboardSseEvent,
  DashboardAction,
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
import type { AgentToolName, AgentPermissionMode } from './agent-types.js'
import type { AgentEvent } from './agent-events.js'
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
}

const MUTATION_ACTIONS = [
  'dashboard.create', 'dashboard.add_panels', 'dashboard.remove_panels', 'dashboard.modify_panel',
  'dashboard.rearrange', 'dashboard.add_variable', 'dashboard.set_title',
  'investigation.create',
  'create_alert_rule', 'modify_alert_rule', 'delete_alert_rule',
] as const;

function checkPermission(mode: AgentPermissionMode, action: string): 'allow' | 'block' | 'approval_required' | 'propose_only' {
  const isMutation = (MUTATION_ACTIONS as readonly string[]).includes(action);
  if (!isMutation) return 'allow';
  if (mode === 'read_only') return 'block';
  if (mode === 'approval_required') return 'approval_required';
  if (mode === 'propose_only') return 'propose_only';
  return 'allow';
}

const log = createLogger('orchestrator')

export class OrchestratorAgent {
  static readonly definition = agentRegistry.get('orchestrator')!;

  private readonly actionExecutor: ActionExecutor
  private readonly alertRuleAgent: AlertRuleAgent
  private readonly reactLoop: ReActLoop
  private pendingConversationActions: DashboardAction[] = []
  private pendingNavigateTo?: string
  readonly sessionId: string

  constructor(private deps: OrchestratorDeps, sessionId?: string) {
    this.sessionId = sessionId ?? randomUUID()
    this.actionExecutor = new ActionExecutor(deps.store, deps.sendEvent)

    this.alertRuleAgent = new AlertRuleAgent({
      gateway: deps.gateway,
      model: deps.model,
      metrics: deps.metricsAdapter,
    })

    this.reactLoop = new ReActLoop({
      gateway: deps.gateway,
      model: deps.model,
      sendEvent: deps.sendEvent,
      maxTokenBudget: deps.maxTokenBudget,
    })

    log.info(`[Orchestrator] init: metricsAdapter=${deps.metricsAdapter ? 'SET' : 'UNSET'}`)
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
      agentType: OrchestratorAgent.definition.type,
      timestamp: new Date().toISOString(),
      ...(metadata ? { metadata } : {}),
    };
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
    const agentDef = OrchestratorAgent.definition;

    // --- Tool boundary enforcement ---
    if (!agentDef.allowedTools.includes(action as AgentToolName)) {
      log.warn(`[Orchestrator] agent attempted undeclared tool "${action}" — blocked`);
      this.emitAgentEvent(this.makeAgentEvent('agent.tool_blocked', { tool: action, reason: 'undeclared_tool' }));
      return `Tool "${action}" is not permitted for this agent.`;
    }

    // --- Permission mode enforcement ---
    const permissionResult = checkPermission(agentDef.permissionMode, action);
    if (permissionResult === 'block') {
      log.warn(`[Orchestrator] mutation "${action}" blocked — agent is read_only`);
      this.emitAgentEvent(this.makeAgentEvent('agent.tool_blocked', { tool: action, reason: 'read_only' }));
      return `Action "${action}" is blocked: agent is in read-only mode.`;
    }
    if (permissionResult === 'approval_required') {
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
    if (permissionResult === 'propose_only') {
      log.info({ action }, 'mutation proposed but not applied — agent is propose_only');
      this.emitAgentEvent(this.makeAgentEvent('agent.artifact_proposed', { tool: action, args }));
      this.deps.sendEvent({
        type: 'tool_result',
        tool: action,
        summary: `Proposed "${action}" (not applied — propose-only mode)`,
        success: true,
      });
      return `Proposed "${action}" with args ${JSON.stringify(args).slice(0, 200)}. Not applied in propose-only mode.`;
    }

    // --- Emit tool_called event ---
    this.emitAgentEvent(this.makeAgentEvent('agent.tool_called', { tool: action }));

    const ctx = this.buildActionContext()

    try {
      switch (action) {
        // Dashboard lifecycle
        case 'dashboard.create': return handleDashboardCreate(ctx, args)
        // Dashboard mutation primitives (dashboardId comes from args)
        case 'dashboard.add_panels': return handleDashboardAddPanels(ctx, args)
        case 'dashboard.set_title': return handleDashboardSetTitle(ctx, args)
        case 'dashboard.remove_panels': return handleDashboardRemovePanels(ctx, args)
        case 'dashboard.modify_panel': return handleDashboardModifyPanel(ctx, args)
        case 'dashboard.add_variable': return handleDashboardAddVariable(ctx, args)
        // Investigation lifecycle
        case 'investigation.create': return handleInvestigationCreate(ctx, args)
        // Alert rules
        case 'create_alert_rule': return handleCreateAlertRule(ctx, args)
        case 'modify_alert_rule': return handleModifyAlertRule(ctx, args)
        case 'delete_alert_rule': return handleDeleteAlertRule(ctx, args)
        // Prometheus primitives
        case 'prometheus.query': return handlePrometheusQuery(ctx, args)
        case 'prometheus.range_query': return handlePrometheusRangeQuery(ctx, args)
        case 'prometheus.labels': return handlePrometheusLabels(ctx, args)
        case 'prometheus.label_values': return handlePrometheusLabelValues(ctx, args)
        case 'prometheus.series': return handlePrometheusSeries(ctx, args)
        case 'prometheus.metadata': return handlePrometheusMetadata(ctx, args)
        case 'prometheus.metric_names': return handlePrometheusMetricNames(ctx)
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
