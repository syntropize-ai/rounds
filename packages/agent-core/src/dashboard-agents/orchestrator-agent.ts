import { randomUUID } from 'node:crypto'
import { createLogger } from '@agentic-obs/common'
import type {
  DashboardSseEvent,
  DashboardAction,
  DashboardMessage,
  Dashboard,
  DashboardVariable,
  Evidence,
  Hypothesis,
  ExplanationResult,
} from '@agentic-obs/common'
import type {
  IDashboardAgentStore,
  IConversationStore,
  IInvestigationReportStore,
  IInvestigationStore,
  IAlertRuleStore,
  DatasourceConfig,
} from './types.js'
import type { IMetricsAdapter } from '../adapters/index.js'
import type { LLMGateway } from '@agentic-obs/llm-gateway'
import { DashboardGeneratorAgent } from './dashboard-generator-agent.js'
import { PanelAdderAgent } from './panel-adder-agent.js'
import { PanelEditorAgent } from './panel-editor-agent.js'
import { PanelExplainAgent } from './panel-explain-agent.js'
import { InvestigationAgent } from './investigation-agent.js'
import { ActionExecutor } from './action-executor.js'
import { AlertRuleAgent } from './alert-rule-agent.js'
import { DiscoveryAgent } from './discovery-agent.js'
import { ReActLoop, type ReActStep } from './react-loop.js'
import { VerifierAgent } from '../verification/verifier-agent.js'
import { agentRegistry } from '../runtime/agent-registry.js'
import type { AgentToolName, AgentPermissionMode } from '../runtime/agent-types.js'
import type { AgentEvent } from '../runtime/agent-events.js'

export interface OrchestratorDeps {
  gateway: LLMGateway
  model: string
  store: IDashboardAgentStore
  conversationStore: IConversationStore
  investigationReportStore: IInvestigationReportStore
  investigationStore?: IInvestigationStore
  alertRuleStore: IAlertRuleStore
  metricsAdapter?: IMetricsAdapter
  /** All configured datasources - used to inform the LLM about available environments */
  allDatasources?: DatasourceConfig[]
  sendEvent: (event: DashboardSseEvent) => void
  timeRange?: { start: string; end: string; timezone?: string }
  /** Maximum total tokens per chat message. Default: 50000 */
  maxTokenBudget?: number
}

const MUTATION_ACTIONS = [
  'add_panels', 'remove_panels', 'modify_panel', 'rearrange',
  'add_variable', 'set_title', 'generate_dashboard', 'create_alert_rule', 'modify_alert_rule', 'delete_alert_rule',
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

interface AlertRuleContext {
  id: string
  name: string
  severity: string
  condition: Record<string, unknown>
  createdAt?: string
  updatedAt?: string
}

export class OrchestratorAgent {
  static readonly definition = agentRegistry.get('intent-router')!;

  private readonly actionExecutor: ActionExecutor
  private readonly generatorAgent: DashboardGeneratorAgent
  private readonly panelAdderAgent: PanelAdderAgent
  private readonly panelEditorAgent: PanelEditorAgent
  private readonly panelExplainAgent?: PanelExplainAgent
  private readonly investigationAgent?: InvestigationAgent
  private readonly alertRuleAgent: AlertRuleAgent
  private readonly reactLoop: ReActLoop
  private readonly verifierAgent: VerifierAgent
  private pendingConversationActions: DashboardAction[] = []
  private pendingNavigateTo?: string

  constructor(private deps: OrchestratorDeps) {
    this.actionExecutor = new ActionExecutor(deps.store, deps.sendEvent)

    const subAgentDeps = {
      gateway: deps.gateway,
      model: deps.model,
      metrics: deps.metricsAdapter,
      sendEvent: deps.sendEvent,
    }

    this.generatorAgent = new DashboardGeneratorAgent(subAgentDeps)
    this.panelAdderAgent = new PanelAdderAgent(subAgentDeps)
    this.panelEditorAgent = new PanelEditorAgent({
      gateway: deps.gateway,
      model: deps.model,
      panelAdderAgent: this.panelAdderAgent,
    })

    if (deps.metricsAdapter) {
      this.panelExplainAgent = new PanelExplainAgent({
        gateway: deps.gateway,
        model: deps.model,
        metrics: deps.metricsAdapter,
      })
    }

    if (deps.metricsAdapter) {
      this.investigationAgent = new InvestigationAgent({
        gateway: deps.gateway,
        model: deps.model,
        metrics: deps.metricsAdapter,
        sendEvent: deps.sendEvent,
      })
    }

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

    this.verifierAgent = new VerifierAgent()

    log.info(`[Orchestrator] init: metricsAdapter=${deps.metricsAdapter ? 'SET' : 'UNSET'}, investigationAgent=${this.investigationAgent ? 'YES' : 'NO'}`)
  }

  private emitAgentEvent(event: AgentEvent): void {
    this.deps.sendEvent({ type: 'agent_event', event } as any);
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

  private async executePanelEdit(
    dashboardId: string,
    userMessage: string,
    requestedAction: 'modify_panel' | 'remove_panels' | 'rearrange',
    args: Record<string, unknown>,
  ): Promise<string> {
    const currentDash = await this.deps.store.findById(dashboardId)
    if (!currentDash) throw new Error('Dashboard not found')

    const displayText = requestedAction === 'modify_panel'
      ? `Editing panels: ${userMessage}`
      : requestedAction === 'remove_panels'
        ? `Removing panel(s)`
        : 'Rearranging panel layout'

    this.deps.sendEvent({
      type: 'tool_call',
      tool: requestedAction,
      args,
      displayText,
    })

    const plan = await this.panelEditorAgent.planEdit({
      userRequest: userMessage,
      requestedAction,
      requestedArgs: args,
      dashboard: currentDash,
    })

    if (plan.actions.length === 0) {
      this.deps.sendEvent({
        type: 'tool_result',
        tool: requestedAction,
        summary: plan.summary,
        success: false,
      })
      this.emitAgentEvent(this.makeAgentEvent('agent.tool_completed', { tool: requestedAction, summary: plan.summary }))
      return plan.summary
    }

    await this.actionExecutor.execute(dashboardId, plan.actions)

    let verificationFailed = false
    let verificationIssues = ''
    const updatedDash = await this.deps.store.findById(dashboardId)
    if (updatedDash) {
      const verificationReport = await this.verifierAgent.verify('dashboard', updatedDash, {
        metricsAdapter: this.deps.metricsAdapter,
      })
      this.deps.sendEvent({ type: 'verification_report', report: verificationReport })
      this.emitAgentEvent(this.makeAgentEvent('agent.artifact_verified', {
        tool: requestedAction,
        status: verificationReport.status,
        summary: verificationReport.summary,
      }))

      if (verificationReport.status === 'failed') {
        verificationFailed = true
        verificationIssues = verificationReport.issues
          .filter((issue) => issue.severity === 'error')
          .map((issue) => issue.message)
          .join('; ')
        await this.deps.store.updatePanels(dashboardId, currentDash.panels)
        await this.deps.store.updateVariables(dashboardId, currentDash.variables)
      }
    }

    const observationText = verificationFailed
      ? verificationIssues
        ? `Panel edit was reverted because verification failed: ${verificationIssues}`
        : 'Panel edit was reverted because verification failed.'
      : `${plan.summary} No further dashboard mutation is needed for this request.`

    this.deps.sendEvent({
      type: 'tool_result',
      tool: requestedAction,
      summary: verificationFailed ? 'Panel edit reverted after verification failed' : plan.summary,
      success: !verificationFailed,
    })
    this.emitAgentEvent(this.makeAgentEvent('agent.tool_completed', { tool: requestedAction, summary: observationText }))
    return observationText
  }

  private getStructuredAlertRuleContext(history: DashboardMessage[], alertRules: AlertRuleContext[]): AlertRuleContext | null {
    if (alertRules.length === 0) return null

    const byId = new Map(alertRules.map((rule) => [rule.id, rule]))

    for (const message of [...history].reverse()) {
      const actions = message.actions ?? []
      for (const action of [...actions].reverse()) {
        if (
          action.type === 'create_alert_rule'
          || action.type === 'modify_alert_rule'
          || action.type === 'delete_alert_rule'
        ) {
          const match = byId.get(action.ruleId)
          if (match) return match
        }
      }
    }

    return null
  }

  private buildStructuredAlertHistory(history: DashboardMessage[]): string {
    const entries: string[] = []

    for (const message of history.slice(-10)) {
      const actions = message.actions ?? []
      for (const action of actions) {
        if (action.type === 'create_alert_rule') {
          entries.push(`- Assistant created alert [${action.ruleId}] "${action.name}" (${action.severity}) - ${action.query} ${action.operator} ${action.threshold}`)
        }
        else if (action.type === 'modify_alert_rule') {
          entries.push(`- Assistant modified alert [${action.ruleId}] with patch ${JSON.stringify(action.patch)}`)
        }
        else if (action.type === 'delete_alert_rule') {
          entries.push(`- Assistant deleted alert [${action.ruleId}]${action.name ? ` "${action.name}"` : ''}`)
        }
      }
    }

    return entries.join('\n')
  }

  private parseAlertFollowUpAction(
    message: string,
    activeAlertRule: AlertRuleContext | null,
  ): ReActStep | null {
    if (!activeAlertRule) return null

    const trimmed = message.trim()
    if (!trimmed) return null

    if (/(^|\b)(delete|remove)\b|删掉|删除|移除|去掉/.test(trimmed)) {
      return {
        thought: 'Structured alert follow-up delete',
        action: 'delete_alert_rule',
        args: { ruleId: activeAlertRule.id },
      }
    }

    const thresholdMatch = trimmed.match(/(\d+(?:\.\d+)?)\s*(ms|s|sec|secs|seconds|m|min|mins|minutes)?/i)
    const hasModifyIntent = /(改|修改|调成|调整|change|update|make|set)/i.test(trimmed)
      || /通知我|告诉我|alert me|notify me/i.test(trimmed)
      || thresholdMatch !== null

    if (!hasModifyIntent || !thresholdMatch) return null

    const numericValue = Number(thresholdMatch[1])
    if (!Number.isFinite(numericValue)) return null

    const unit = (thresholdMatch[2] ?? '').toLowerCase()
    const normalizedThreshold =
      unit === 's' || unit === 'sec' || unit === 'secs' || unit === 'seconds'
        ? numericValue * 1000
        : unit === 'm' || unit === 'min' || unit === 'mins' || unit === 'minutes'
          ? numericValue * 60 * 1000
          : numericValue

    const patch: Record<string, unknown> = { threshold: normalizedThreshold }
    if (/小于|低于|less than|below|under/i.test(trimmed)) patch.operator = '<'
    if (/小于等于|不高于|at most|no more than/i.test(trimmed)) patch.operator = '<='
    if (/大于等于|至少|at least|not less than/i.test(trimmed)) patch.operator = '>='
    if (/大于|高于|超过|more than|greater than|over/i.test(trimmed)) patch.operator = '>'

    return {
      thought: 'Structured alert follow-up modify',
      action: 'modify_alert_rule',
      args: {
        ruleId: activeAlertRule.id,
        patch,
      },
    }
  }

  private isPanelExplanationRequest(message: string): boolean {
    const text = message.trim().toLowerCase()
    if (!text) return false
    return /(讲|解释|说明|分析|看看|看下|什么情况|数据情况|走势|趋势|怎么样|how is|what.*show|explain|interpret|analy[sz]e)/i.test(text)
      && /(panel|latency|error|rate|request|duration|p\d+|average|avg|http|数据|指标|面板)/i.test(text)
  }

  private findRelevantPanel(message: string, dashboard: Dashboard): Dashboard['panels'][number] | null {
    const lowered = message.toLowerCase()
    const scored = dashboard.panels.map((panel) => {
      const title = panel.title.toLowerCase()
      const description = (panel.description ?? '').toLowerCase()
      let score = 0
      if (lowered.includes(title)) score += 5
      const titleTokens = title.split(/[^a-z0-9\u4e00-\u9fa5]+/i).filter((token) => token.length >= 2)
      for (const token of titleTokens) {
        if (lowered.includes(token)) score += 1
      }
      if (description && lowered.includes(description)) score += 2
      return { panel, score }
    })

    scored.sort((left, right) => right.score - left.score)
    return scored[0] && scored[0].score > 0 ? scored[0].panel : null
  }

  private async composeAlertFollowUpReply(
    userMessage: string,
    action: ReActStep,
    observationText: string,
  ): Promise<string> {
    try {
      const resp = await this.deps.gateway.complete([
        {
          role: 'system',
          content: 'You are writing a short assistant reply for an observability dashboard chat. The requested action has already succeeded. Reply in one natural sentence. Do not mention tool names, internal IDs, or implementation details.',
        },
        {
          role: 'user',
          content: `User request: ${userMessage}\nExecuted action: ${action.action}\nResult: ${observationText}`,
        },
      ], {
        model: this.deps.model,
        maxTokens: 80,
        temperature: 0.2,
      })

      const text = resp.content.trim()
      if (text) return text
    }
    catch {
      // Fall back to the execution summary below.
    }

    return observationText
  }

  async handleMessage(dashboardId: string, message: string): Promise<string> {
    this.emitAgentEvent(this.makeAgentEvent('agent.started', { dashboardId, message }));
    this.pendingConversationActions = []
    this.pendingNavigateTo = undefined

    const dashboard = await this.deps.store.findById(dashboardId)
    if (!dashboard) {
      this.emitAgentEvent(this.makeAgentEvent('agent.failed', { reason: 'Dashboard not found' }));
      throw new Error(`Dashboard ${dashboardId} not found`)
    }

    const history = await this.deps.conversationStore.getMessages(dashboardId)

    if (this.panelExplainAgent && this.isPanelExplanationRequest(message)) {
      const panel = this.findRelevantPanel(message, dashboard)
      if (panel && (panel.queries?.length || panel.query)) {
        const explainablePanel = panel.queries?.length
          ? panel
          : {
              ...panel,
              queries: panel.query ? [{ refId: 'A', expr: panel.query, instant: panel.visualization !== 'time_series' }] : [],
            }

        const reply = await this.panelExplainAgent.explain({
          userRequest: message,
          dashboard,
          panel: explainablePanel,
          timeRange: this.deps.timeRange,
        })
        this.deps.sendEvent({ type: 'reply', content: reply })
        this.emitAgentEvent(this.makeAgentEvent('agent.completed', { dashboardId, mode: 'panel_explanation', panelId: panel.id }))
        return reply
      }
    }

    // Fetch existing alert rules so LLM can reference them for modify/delete
    let alertRules: AlertRuleContext[] = []
    if (this.deps.alertRuleStore.findAll) {
      try {
        const result = await this.deps.alertRuleStore.findAll()
        alertRules = (Array.isArray(result) ? result : (result as { list: unknown[] }).list ?? []) as typeof alertRules
      } catch { /* ignore */ }
    }

    const activeAlertRule = this.getStructuredAlertRuleContext(history, alertRules)
    const directFollowUpAction = this.parseAlertFollowUpAction(message, activeAlertRule)
    if (directFollowUpAction) {
      const result = await this.executeAction(dashboardId, directFollowUpAction)
      const finalReply = result
        ? await this.composeAlertFollowUpReply(message, directFollowUpAction, result)
        : ''
      if (finalReply) {
        this.deps.sendEvent({ type: 'reply', content: finalReply })
      }
      this.emitAgentEvent(this.makeAgentEvent('agent.completed', { dashboardId, mode: 'structured_alert_followup' }));
      return finalReply
    }

    const systemPrompt = this.buildSystemPrompt(dashboard, history, alertRules, activeAlertRule)

    try {
      const result = await this.reactLoop.runLoop(
        systemPrompt,
        message,
        (step) => this.executeAction(dashboardId, step, message),
      )
      this.emitAgentEvent(this.makeAgentEvent('agent.completed', { dashboardId }));
      return result;
    }
    catch (err) {
      this.emitAgentEvent(this.makeAgentEvent('agent.failed', {
        dashboardId,
        error: err instanceof Error ? err.message : String(err),
      }));
      throw err;
    }
  }

  private extractEvidenceFromReport(
    report: { sections: Array<{ type: string, content?: string, panel?: Dashboard['panels'][number] }> },
  ): Evidence[] {
    const evidence: Evidence[] = []
    for (const section of report.sections) {
      if (section.type !== 'evidence' || !section.panel)
        continue
      const query = section.panel.queries?.[0]?.expr ?? section.panel.query ?? ''
      evidence.push({
        id: randomUUID(),
        hypothesisId: '',
        type: 'metric',
        query,
        queryLanguage: 'promql',
        result: { query, series: [], totalSeries: 0 },
        summary: section.content ?? section.panel.title,
        timestamp: new Date().toISOString(),
        reproducible: true,
      })
    }
    return evidence
  }

  private extractHypothesesFromSummary(
    investigationId: string,
    summary: string,
    evidence: Evidence[],
  ): Hypothesis[] {
    return [{
      id: randomUUID(),
      investigationId,
      description: summary,
      confidence: 0.7,
      confidenceBasis: `Based on ${evidence.length} evidence items`,
      status: 'supported',
      evidenceIds: evidence.map((item) => item.id),
      counterEvidenceIds: [],
    }]
  }

  private async executeAction(dashboardId: string, step: ReActStep, userMessage = ''): Promise<string | null> {
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
      } as any);
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

    try {
      switch (action) {
        case 'generate_dashboard': {
          const goal = String(args.goal ?? '')

          this.deps.sendEvent({
            type: 'tool_call',
            tool: 'generate_dashboard',
            args: { goal },
            displayText: `Generating dashboard: ${goal}`,
          })

          const currentDash = await this.deps.store.findById(dashboardId)
          if (!currentDash)
            throw new Error('Dashboard not found')

          const onGroupDone = async (panels: import('@agentic-obs/common').PanelConfig[]) => {
            await this.actionExecutor.execute(dashboardId, [{ type: 'add_panels', panels }])
          }

          const result = await this.generatorAgent.generate({
            goal,
            existingPanels: currentDash.panels,
            existingVariables: currentDash.variables,
          }, onGroupDone)

          // Discovery found 0 relevant metrics — ask the user for clarification
          if (result.needsClarification) {
            const { searchedFor, totalMetricsInPrometheus, candidateMetrics } = result.needsClarification
            let clarificationMsg = `I searched for metrics related to "${searchedFor}" but found no relevant matches in your Prometheus instance (${totalMetricsInPrometheus} total metrics available).`
            if (candidateMetrics.length > 0) {
              const listed = candidateMetrics.slice(0, 10).join(', ')
              clarificationMsg += `\n\nSome potentially related metrics I found: ${listed}`
              if (candidateMetrics.length > 10) {
                clarificationMsg += ` (and ${candidateMetrics.length - 10} more)`
              }
            }
            clarificationMsg += '\n\nCould you clarify what you\'d like to monitor? For example, you could specify a metric prefix or the service/exporter name.'

            this.deps.sendEvent({
              type: 'tool_result',
              tool: 'generate_dashboard',
              summary: 'No relevant metrics found — asking user for clarification',
              success: false,
            })
            this.emitAgentEvent(this.makeAgentEvent('agent.tool_completed', {
              tool: 'generate_dashboard',
              summary: 'needsClarification — 0 relevant metrics',
            }))
            // Return the clarification message as observation text.
            // The ReAct loop will see this and the LLM should route to ask_user.
            return `CLARIFICATION_NEEDED: ${clarificationMsg}`
          }

          if (result.title) {
            await this.actionExecutor.execute(dashboardId, [{
              type: 'set_title',
              title: result.title,
              ...(result.description ? { description: result.description } : {}),
            }])
          }

          // Replace panels in store with layout-applied panels from generator
          // (onGroupDone added panels before layout was computed; this overwrites with final layout)
          if (result.panels.length > 0) {
            await this.deps.store.updatePanels(dashboardId, result.panels)
          }

          if (result.variables && result.variables.length > 0) {
            for (const variable of result.variables) {
              await this.actionExecutor.execute(dashboardId, [{ type: 'add_variable', variable }])
            }
          }

          // Run verification on the generated dashboard
          const updatedDash = await this.deps.store.findById(dashboardId)
          let verificationFailed = false
          if (updatedDash) {
            const verificationReport = await this.verifierAgent.verify('dashboard', updatedDash, {
              metricsAdapter: this.deps.metricsAdapter,
            })
            this.deps.sendEvent({ type: 'verification_report', report: verificationReport })
            this.emitAgentEvent(this.makeAgentEvent('agent.artifact_verified', {
              tool: 'generate_dashboard',
              status: verificationReport.status,
              summary: verificationReport.summary,
            }));
            if (verificationReport.status === 'failed') {
              verificationFailed = true
              log.warn({ summary: verificationReport.summary }, 'dashboard verification failed — rolling back panels')
              // Rollback: remove the panels we just added
              const panelIdsToRemove = result.panels.map((p) => p.id)
              if (panelIdsToRemove.length > 0) {
                await this.actionExecutor.execute(dashboardId, [{ type: 'remove_panels', panelIds: panelIdsToRemove }])
              }
              // Rollback title
              if (result.title) {
                await this.actionExecutor.execute(dashboardId, [{ type: 'set_title', title: currentDash.title }])
              }
              // Rollback variables — remove_variable action not yet supported, log warning
              if (result.variables?.length) {
                log.warn(
                  { count: result.variables.length },
                  'cannot rollback added variables — remove_variable action not implemented; variables may remain',
                )
              }
            }
          }

          const observationText = verificationFailed
            ? `Generated ${result.panels.length} panels but some had issues (panels rolled back).`
            : `Generated ${result.panels.length} panels`
              + (result.variables?.length ? ` and ${result.variables.length} variables` : '')

          this.deps.sendEvent({
            type: 'tool_result',
            tool: 'generate_dashboard',
            summary: observationText,
            success: !verificationFailed && result.panels.length > 0,
          })
          this.emitAgentEvent(this.makeAgentEvent('agent.tool_completed', { tool: 'generate_dashboard', summary: observationText }));
          return observationText
        }

        case 'add_panels': {
          const goal = String(args.goal ?? '')
          const currentDash = await this.deps.store.findById(dashboardId)
          if (!currentDash)
            throw new Error('Dashboard not found')

          this.deps.sendEvent({
            type: 'tool_call',
            tool: 'add_panels',
            args: { goal },
            displayText: `Adding panels: ${goal}`,
          })

          // Discover available metrics and labels before generating panels
          let availableMetrics: string[] = []
          let labelsByMetric: Record<string, string[]> = {}
          if (this.deps.metricsAdapter) {
            try {
              const discoveryAgent = new DiscoveryAgent(
                this.deps.metricsAdapter,
                this.deps.sendEvent,
              )
              // Extract metric search keywords from goal using LLM
              let searchPatterns: string[]
              try {
                const kwResp = await this.deps.gateway.complete([
                  { role: 'system', content: 'Extract 3-5 short metric name keywords/prefixes from the user goal. Return ONLY a JSON array of strings like ["http", "request", "duration"]. No explanation.' },
                  { role: 'user', content: goal },
                ], { model: this.deps.model, maxTokens: 100, temperature: 0, responseFormat: 'json' })
                const parsed = JSON.parse(kwResp.content.replace(/```json\n?/g, '').replace(/```/g, '').trim())
                searchPatterns = Array.isArray(parsed) ? parsed : [goal]
              } catch {
                searchPatterns = goal.split(/\s+/).filter((w) => w.length > 3)
              }
              const discovery = await discoveryAgent.discover(searchPatterns)
              availableMetrics = discovery.metrics
              // Build label context with actual values from samples
              labelsByMetric = discovery.labelsByMetric
              // Enrich with sample label values so LLM knows e.g. job="prometheus"
              for (const [metric, sample] of Object.entries(discovery.sampleValues)) {
                if (sample.sampleLabels.length > 0) {
                  const valueContext = sample.sampleLabels.map((labels) =>
                    Object.entries(labels).map(([k, v]) => `${k}="${v}"`).join(', ')
                  )
                  labelsByMetric[metric] = [...(labelsByMetric[metric] ?? []), `  sample: {${valueContext[0]}}`]
                }
              }
            } catch (err) {
              log.warn({ err: err instanceof Error ? err.message : err }, 'metric discovery failed, proceeding without context')
            }
          }

          const result = await this.panelAdderAgent.addPanels({
            goal,
            existingPanels: currentDash.panels,
            existingVariables: currentDash.variables,
            availableMetrics,
            labelsByMetric,
            gridNextRow: currentDash.panels.length > 0
              ? Math.max(...currentDash.panels.map((p) => p.row + p.height))
              : 0,
          })

          if (result.panels.length > 0) {
            await this.actionExecutor.execute(dashboardId, [{ type: 'add_panels', panels: result.panels }])
          }

          if (result.variables && result.variables.length > 0) {
            for (const variable of result.variables) {
              await this.actionExecutor.execute(dashboardId, [{ type: 'add_variable', variable }])
            }
          }

          // Run verification on the updated dashboard
          const updatedDashForPanels = await this.deps.store.findById(dashboardId)
          let addPanelsVerificationFailed = false
          if (updatedDashForPanels) {
            const verificationReport = await this.verifierAgent.verify('dashboard', updatedDashForPanels, {
              metricsAdapter: this.deps.metricsAdapter,
            })
            this.deps.sendEvent({ type: 'verification_report', report: verificationReport })
            this.emitAgentEvent(this.makeAgentEvent('agent.artifact_verified', {
              tool: 'add_panels',
              status: verificationReport.status,
              summary: verificationReport.summary,
            }));
            if (verificationReport.status === 'failed') {
              addPanelsVerificationFailed = true
              await this.deps.store.updatePanels(dashboardId, currentDash.panels)
            }
          }

          const observationText = addPanelsVerificationFailed
            ? 'The new panels were not applied because verification found problems with the result.'
            : `Added ${result.panels.length} panel(s)` + (result.variables?.length ? ` and ${result.variables.length} variable(s)` : '')

          this.deps.sendEvent({
            type: 'tool_result',
            tool: 'add_panels',
            summary: addPanelsVerificationFailed ? 'Panel addition was reverted after verification failed' : observationText,
            success: result.panels.length > 0 && !addPanelsVerificationFailed,
          })
          this.emitAgentEvent(this.makeAgentEvent('agent.tool_completed', { tool: 'add_panels', summary: observationText }));
          return observationText
        }

        case 'investigate': {
          const goal = String(args.goal ?? '')
          this.deps.sendEvent({
            type: 'tool_call',
            tool: 'investigate',
            args: { goal },
            displayText: `Investigating: ${goal}`,
          })

          if (!this.investigationAgent) {
            const observationText = 'Investigation requires Prometheus - no Prometheus URL configured.'
            this.deps.sendEvent({ type: 'tool_result', tool: 'investigate', summary: observationText, success: false })
            return observationText
          }

          const currentDash = await this.deps.store.findById(dashboardId)
          if (!currentDash)
            throw new Error('Dashboard not found')

          const result = await this.investigationAgent.investigate({
            goal,
            existingPanels: currentDash.panels,
            gridNextRow: currentDash.panels.length > 0
              ? Math.max(...currentDash.panels.map((p) => p.row + p.height))
              : 0,
          })

          // Run verification on the investigation report
          const verificationReport = await this.verifierAgent.verify('investigation_report', result.report, {
            metricsAdapter: this.deps.metricsAdapter,
          })
          this.deps.sendEvent({ type: 'verification_report', report: verificationReport })
          this.emitAgentEvent(this.makeAgentEvent('agent.artifact_verified', {
            tool: 'investigate',
            status: verificationReport.status,
            summary: verificationReport.summary,
          }));

          // Save report and provide a navigable link
          const reportId = randomUUID()
          this.deps.investigationReportStore.save({
            id: reportId,
            dashboardId,
            goal,
            summary: result.summary,
            sections: result.report.sections,
            createdAt: new Date().toISOString(),
          })

          if (this.deps.investigationStore) {
            const investigation = await this.deps.investigationStore.create({
              question: goal,
              sessionId: `ses_dash_${Date.now()}`,
              userId: currentDash.userId ?? 'anonymous',
            })

            const evidence = this.extractEvidenceFromReport(result.report)
            const hypotheses = this.extractHypothesesFromSummary(investigation.id, result.summary, evidence)
            const conclusion: ExplanationResult = {
              summary: result.summary,
              rootCause: null,
              confidence: 0.7,
              recommendedActions: [],
            }

            await this.deps.investigationStore.updatePlan(investigation.id, {
              entity: currentDash.title,
              objective: goal,
              steps: [
                { id: 'plan', type: 'plan', description: 'Plan investigation queries', status: 'completed' },
                { id: 'query', type: 'query', description: 'Execute Prometheus queries', status: 'completed' },
                { id: 'analyze', type: 'analyze', description: 'Analyze evidence and generate report', status: 'completed' },
              ],
              stopConditions: [],
            })
            await this.deps.investigationStore.updateResult(investigation.id, {
              hypotheses,
              evidence,
              conclusion,
            })
              await this.deps.investigationReportStore.save({
                id: randomUUID(),
                dashboardId: investigation.id,
                goal,
                summary: result.report.summary,
                sections: result.report.sections,
                createdAt: new Date().toISOString(),
              })
              await this.deps.investigationStore.updateStatus(investigation.id, 'completed')
              this.pendingNavigateTo = `/investigations/${investigation.id}`
            }

          const observationText = result.summary
          this.deps.sendEvent({
            type: 'tool_result',
            tool: 'investigate',
            summary: `Investigation complete — ${result.panels.length} evidence panels added. [View report](/investigations)`,
            success: !verificationReport || verificationReport.status !== 'failed',
          })
          this.emitAgentEvent(this.makeAgentEvent('agent.tool_completed', { tool: 'investigate', summary: observationText }));
          return observationText
        }

        case 'remove_panels': {
          return this.executePanelEdit(dashboardId, userMessage, 'remove_panels', args)
        }

        case 'modify_panel': {
          return this.executePanelEdit(dashboardId, userMessage, 'modify_panel', args)
        }

        case 'rearrange': {
          return this.executePanelEdit(dashboardId, userMessage, 'rearrange', args)
        }

        case 'add_variable': {
          const variable = args.variable as DashboardVariable
          this.deps.sendEvent({
            type: 'tool_call',
            tool: 'add_variable',
            args: { variable },
            displayText: `Adding variable: ${variable?.name ?? ''}`,
          })

          const addVarAction: DashboardAction = { type: 'add_variable', variable }
          await this.actionExecutor.execute(dashboardId, [addVarAction])
          const observationText = `Added variable: ${variable?.name ?? ''}.`

          this.deps.sendEvent({
            type: 'tool_result',
            tool: 'add_variable',
            summary: `Variable ${variable?.name ?? ''} added`,
            success: true,
          })
          this.emitAgentEvent(this.makeAgentEvent('agent.tool_completed', { tool: 'add_variable', summary: observationText }));
          return observationText
        }

        case 'set_title': {
          const title = String(args.title ?? '')
          const description = typeof args.description === 'string' ? args.description : undefined
          this.deps.sendEvent({
            type: 'tool_call',
            tool: 'set_title',
            args: { title, ...(description !== undefined ? { description } : {}) },
            displayText: `Setting title: "${title}"`,
          })

          const titleAction: DashboardAction = {
            type: 'set_title',
            title,
            ...(description !== undefined ? { description } : {}),
          }
          await this.actionExecutor.execute(dashboardId, [titleAction])
          const observationText = `Title set to "${title}".`

          this.deps.sendEvent({
            type: 'tool_result',
            tool: 'set_title',
            summary: `Title updated to "${title}"`,
            success: true,
          })
          this.emitAgentEvent(this.makeAgentEvent('agent.tool_completed', { tool: 'set_title', summary: observationText }));
          return observationText
        }

        case 'create_alert_rule': {
          const prompt = String(args.prompt ?? args.goal ?? '')
          this.deps.sendEvent({
            type: 'tool_call',
            tool: 'create_alert_rule',
            args: { prompt },
            displayText: `Creating alert rule: ${prompt.slice(0, 60)}`,
          })

          const currentDash = await this.deps.store.findById(dashboardId)
          const existingQueries = (currentDash?.panels ?? [])
            .flatMap((p) => [
              ...(p.queries ?? []).map((q) => q.expr),
              ...(typeof p.query === 'string' && p.query.trim().length > 0 ? [p.query] : []),
            ])
            .filter(Boolean)
          const variables = (currentDash?.variables ?? []).map((v) => ({
            name: v.name,
            value: v.current,
          }))

          const result = await this.alertRuleAgent.generate(prompt, {
            dashboardId,
            dashboardTitle: currentDash?.title,
            existingQueries: existingQueries.length > 0 ? existingQueries : undefined,
            variables: variables.length > 0 ? variables : undefined,
          })
          const generated = result.rule

          if (result.verificationReport) {
            this.deps.sendEvent({
              type: 'verification_report',
              report: result.verificationReport,
            })

            if (result.verificationReport.status === 'failed') {
              const failIssues = result.verificationReport.issues
                .filter((i) => i.severity === 'error')
                .map((i) => i.message)
                .join('; ')
              this.deps.sendEvent({
                type: 'tool_result',
                tool: 'create_alert_rule',
                summary: `Alert rule verification failed — rule NOT saved`,
                success: false,
              })
              this.emitAgentEvent(this.makeAgentEvent('agent.tool_completed', { tool: 'create_alert_rule', summary: 'blocked by verifier' }));
              return `Alert rule verification failed: ${failIssues}. Rule was NOT saved.`
            }
          }

          // Upsert: if a rule with the same name exists, update it instead of creating a duplicate
          let rule: Record<string, unknown> | undefined
          let isUpdate = false
          if (this.deps.alertRuleStore.findAll && this.deps.alertRuleStore.update) {
            try {
              const existing = await this.deps.alertRuleStore.findAll()
              const list = (Array.isArray(existing) ? existing : (existing as { list: unknown[] }).list ?? []) as Array<{ id: string; name: string }>
              const match = list.find((r) => r.name === generated.name)
              if (match) {
                rule = await this.deps.alertRuleStore.update(match.id, {
                  description: generated.description,
                  condition: generated.condition,
                  evaluationIntervalSec: generated.evaluationIntervalSec,
                  severity: generated.severity,
                }) as Record<string, unknown> | undefined
                isUpdate = true
              }
            } catch { /* fall through to create */ }
          }

          if (!rule) {
            rule = await this.deps.alertRuleStore.create({
              name: generated.name,
              description: generated.description,
              originalPrompt: prompt,
              condition: generated.condition,
              evaluationIntervalSec: generated.evaluationIntervalSec,
              severity: generated.severity,
              labels: {
                ...generated.labels,
                ...(dashboardId ? { dashboardId } : {}),
              },
              createdBy: 'llm',
            }) as Record<string, unknown>
          }

          const rc = rule.condition as Record<string, unknown>
          const verb = isUpdate ? 'Updated' : 'Created'
          this.pendingConversationActions.push({
            type: 'create_alert_rule',
            ruleId: String(rule.id ?? ''),
            name: String(rule.name ?? generated.name),
            severity: String(rule.severity ?? generated.severity),
            query: String(rc.query ?? ''),
            operator: String(rc.operator ?? ''),
            threshold: Number(rc.threshold ?? 0),
            forDurationSec: Number(rc.forDurationSec ?? 0),
            evaluationIntervalSec: Number(rule.evaluationIntervalSec ?? generated.evaluationIntervalSec),
          })
          const observationText = `${verb} alert rule "${rule.name}" (id: ${rule.id ?? 'unknown'}, ${rule.severity}, evaluating every ${rule.evaluationIntervalSec}s). Rule: ${rc.query} ${rc.operator} ${rc.threshold} for ${rc.forDurationSec}s.${generated.autoInvestigate ? ' Auto-investigation enabled on fire.' : ''}`
          this.deps.sendEvent({
            type: 'tool_result',
            tool: 'create_alert_rule',
            summary: `Alert rule "${rule.name}" ${verb.toLowerCase()}`,
            success: true,
          })
          this.emitAgentEvent(this.makeAgentEvent('agent.tool_completed', { tool: 'create_alert_rule', summary: observationText }));
          return observationText
        }

        case 'modify_alert_rule': {
          const ruleId = String(args.ruleId ?? '')
          const patch = (args.patch ?? args) as Record<string, unknown>
          if (!ruleId) return 'Error: ruleId is required for modify_alert_rule.'
          if (!this.deps.alertRuleStore.update) return 'Error: alert rule store does not support updates.'
          if (!this.deps.alertRuleStore.findById) return 'Error: alert rule store does not support findById.'

          this.deps.sendEvent({
            type: 'tool_call',
            tool: 'modify_alert_rule',
            args: { ruleId, patch },
            displayText: `Updating alert rule ${ruleId}...`,
          })

          // Fetch existing rule to merge condition fields
          const existingRule = await this.deps.alertRuleStore.findById(ruleId) as Record<string, unknown> | undefined
          if (!existingRule) return `Error: alert rule ${ruleId} not found.`

          const updatePatch: Record<string, unknown> = {}
          if (patch.severity) updatePatch.severity = patch.severity
          if (patch.evaluationIntervalSec) updatePatch.evaluationIntervalSec = patch.evaluationIntervalSec
          if (patch.name) updatePatch.name = patch.name

          // Merge condition: start from existing, overlay changes
          const existingCondition = (existingRule.condition ?? {}) as Record<string, unknown>
          const hasConditionChanges = patch.threshold !== undefined || patch.operator || patch.forDurationSec !== undefined || patch.query
          if (hasConditionChanges) {
            updatePatch.condition = {
              ...existingCondition,
              ...(patch.threshold !== undefined ? { threshold: patch.threshold } : {}),
              ...(patch.operator ? { operator: patch.operator } : {}),
              ...(patch.forDurationSec !== undefined ? { forDurationSec: patch.forDurationSec } : {}),
              ...(patch.query ? { query: patch.query } : {}),
            }
          }

          const updatedRule = await this.deps.alertRuleStore.update(ruleId, updatePatch) as Record<string, unknown> | undefined

          this.pendingConversationActions.push({
            type: 'modify_alert_rule',
            ruleId,
            patch: {
              ...(patch.threshold !== undefined ? { threshold: Number(patch.threshold) } : {}),
              ...(typeof patch.operator === 'string' ? { operator: patch.operator } : {}),
              ...(typeof patch.severity === 'string' ? { severity: patch.severity } : {}),
              ...(patch.forDurationSec !== undefined ? { forDurationSec: Number(patch.forDurationSec) } : {}),
              ...(patch.evaluationIntervalSec !== undefined ? { evaluationIntervalSec: Number(patch.evaluationIntervalSec) } : {}),
              ...(typeof patch.query === 'string' ? { query: patch.query } : {}),
              ...(typeof patch.name === 'string' ? { name: patch.name } : {}),
            },
          })

          const updatedRuleName = String(updatedRule?.name ?? existingRule.name ?? 'the alert rule')
          const updatedCondition = ((updatedRule?.condition ?? updatePatch.condition ?? existingCondition) as Record<string, unknown>)
          const thresholdText = updatedCondition.threshold !== undefined ? ` to ${updatedCondition.threshold}` : ''
          const operatorText = typeof updatedCondition.operator === 'string' ? ` (${updatedCondition.operator})` : ''
          const observationText = `Updated "${updatedRuleName}"${thresholdText}${operatorText}.`
          this.deps.sendEvent({
            type: 'tool_result',
            tool: 'modify_alert_rule',
            summary: observationText,
            success: true,
          })
          this.emitAgentEvent(this.makeAgentEvent('agent.tool_completed', { tool: 'modify_alert_rule', summary: observationText }));
          return observationText
        }

        case 'delete_alert_rule': {
          const ruleId = String(args.ruleId ?? '')
          if (!ruleId) return 'Error: ruleId is required for delete_alert_rule.'

          this.deps.sendEvent({
            type: 'tool_call',
            tool: 'delete_alert_rule',
            args: { ruleId },
            displayText: `Deleting alert rule ${ruleId}...`,
          })

          // alertRuleStore may have delete via the repository interface
          const existingRule = this.deps.alertRuleStore.findById
            ? await this.deps.alertRuleStore.findById(ruleId) as Record<string, unknown> | undefined
            : undefined

          const store = this.deps.alertRuleStore as unknown as { delete?(id: string): unknown }
          if (store.delete) {
            await store.delete(ruleId)
          }

          this.pendingConversationActions.push({
            type: 'delete_alert_rule',
            ruleId,
          })

          const deletedRuleName = String(existingRule?.name ?? 'the alert rule')
          const observationText = `Deleted "${deletedRuleName}".`
          this.deps.sendEvent({
            type: 'tool_result',
            tool: 'delete_alert_rule',
            summary: observationText,
            success: true,
          })
          this.emitAgentEvent(this.makeAgentEvent('agent.tool_completed', { tool: 'delete_alert_rule', summary: observationText }));
          return observationText
        }

        default: {
          return `Unknown action "${action}" - skipping.`
        }
      }
    }
    catch (err) {
      const observationText = `Action "${action}" failed: ${err instanceof Error ? err.message : String(err)}. Do NOT retry this action — inform the user of the error and use the "reply" action to end.`
      this.deps.sendEvent({
        type: 'tool_result',
        tool: action,
        summary: observationText,
        success: false,
      })
      this.emitAgentEvent(this.makeAgentEvent('agent.tool_completed', {
        tool: action,
        success: false,
        error: err instanceof Error ? err.message : String(err),
      }));
      return observationText
    }

    // This point is unreachable due to the switch/return structure,
    // but if we did get here, emit completed
  }

  private buildSystemPrompt(
    dashboard: Dashboard,
    history: DashboardMessage[],
    alertRules: AlertRuleContext[] = [],
    activeAlertRule: AlertRuleContext | null = null,
  ): string {
    const panelsSummary = dashboard.panels.length > 0
      ? dashboard.panels.map((p) => `- [${p.id}] ${p.title} (${p.visualization})`).join('\n')
      : '(no panels yet)'

    const variablesSummary = (dashboard.variables ?? []).length > 0
      ? dashboard.variables.map((v) => `- $${v.name}: ${v.query ?? v.options?.join(', ') ?? 'join'}`).join('\n')
      : '(none)'

    const historySection = history.length > 0
      ? `\n## Recent Conversation History\n${history.slice(-10).map((m) => `- ${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}`).join('\n')}\n`
      : ''

    const alertRulesSection = alertRules.length > 0
      ? `\n## Existing Alert Rules\n${alertRules.map((r) => `- [${r.id}] "${r.name}" (${r.severity}) — ${(r.condition as Record<string, unknown>).query ?? ''} ${(r.condition as Record<string, unknown>).operator ?? ''} ${(r.condition as Record<string, unknown>).threshold ?? ''}`).join('\n')}\nUse these IDs with modify_alert_rule or delete_alert_rule.\n`
      : ''

    const structuredAlertHistory = this.buildStructuredAlertHistory(history)
    const structuredAlertHistorySection = structuredAlertHistory
      ? `\n## Structured Alert History\n${structuredAlertHistory}\n`
      : ''

    const activeAlertRuleSection = activeAlertRule
      ? `\n## Active Alert Rule Context\nThe latest structured alert action in this conversation refers to [${activeAlertRule.id}] "${activeAlertRule.name}" (${activeAlertRule.severity}). If the user says "it", "this alert", "change it to 400ms", "改成400ms", or "删掉它", interpret that as this alert unless they explicitly mention a different one.\n`
      : ''

    const datasources = this.deps.allDatasources ?? []
    const datasourceSection = datasources.length > 0
      ? `\n## Available Datasources\n${datasources.map((d) =>
        `- ${d.name} (${d.type}, id: ${d.id}${d.environment ? `, env: ${d.environment}` : ''}${d.cluster ? `, cluster: ${d.cluster}` : ''}${d.isDefault ? ', DEFAULT' : ''})`).join('\n')}\n`
      : ''

    return `You are an observability platform agent that manages monitoring dashboards AND alert rules.
You can create dashboards, investigate issues, AND set up alerting rules that notify users when metrics cross thresholds. You are a conversational router that classifies user intent and delegates to the appropriate tool.

## Current Dashboard State
Title: ${dashboard.title}
Description: ${dashboard.description ?? ''}

## Panels (${dashboard.panels.length} total)
${panelsSummary}

## Variables
${variablesSummary}
${historySection}${datasourceSection}${alertRulesSection}${structuredAlertHistorySection}${activeAlertRuleSection}
## Available Tools

## Sub-agents (for complex work - these handle research, discovery, and panel generation internally)
- generate_dashboard(goal: string) -> dashboard generation with research, metric discovery, and panel planning. The dashboard generator decides the appropriate breadth from the user's request and the available data. Use when the dashboard is empty or the user wants a new dashboard.
- add_panels(goal: string) -> add 1-3 specific panels to an EXISTING dashboard that already has panels. Only use for small incremental additions.
- investigate(goal: string) -> investigate a production issue using real data; generates evidence panels and investigation report.
- create_alert_rule(prompt: string) -> create a NEW alert rule that notifies users when a metric crosses a threshold.
- modify_alert_rule(ruleId: string, patch: { threshold?: number, operator?: string, severity?: string, forDurationSec?: number, evaluationIntervalSec?: number }) -> modify an existing alert rule's properties. Use this when the user wants to change a threshold, severity, or other property of an alert they already created.
- delete_alert_rule(ruleId: string) -> delete an existing alert rule.

## Direct tools (immediate dashboard changes)
- remove_panels(panelIds: string[]) -> remove panels by ID
- modify_panel(panelId: string, patch: object) -> patch a panel's properties (title, queries, visualization, etc.)
- rearrange(layout: Array<{ panelId, row, col }>) -> change panel positions only. Do NOT use this tool to resize panels.
- add_variable(variable: DashboardVariable) -> add a template variable
- set_title(title: string, description?: string) -> update dashboard title/description

## Terminal
- reply(text: string) -> Send final reply to user and end the loop
- ask_user(question: string) -> Ask the user a clarifying question and wait for their response. Use VERY sparingly.

## Intent Classification

Classify the user's intent based on what they are trying to accomplish, not by matching keywords.

**investigate** — The user has a concern about something happening or that happened in their system. They want to understand, diagnose, or get answers about real-time or recent behavior. This applies regardless of whether the dashboard has panels.

**generate_dashboard** — The user wants to set up ongoing monitoring or visibility for a topic, service, or area. They are building a view for the future, not reacting to a current problem.

**add_panels** — The user wants to extend an existing dashboard that already has panels with a small addition.
Use this only when the user is asking to add net-new monitoring content. Do NOT use add_panels for requests that are really edits to existing panels.

**create_alert_rule** — The user wants to create a NEW alert to be notified when something happens.

**modify_alert_rule** — The user wants to change an existing alert rule (e.g. change threshold, severity). Look at recently created alert rules in the conversation history to find the ruleId.

**delete_alert_rule** — The user wants to remove/delete an existing alert rule.

**Direct tools** (modify_panel, remove_panels, rearrange, add_variable, set_title) — The user wants to make a specific change to an existing panel or the dashboard structure.
Choose **modify_panel** for any edit that evolves existing panel content, even if the downstream editor may decide to replace it with newly generated panels. This includes merge, split, duplicate/clone, change visualization, or "make this panel show X instead".
For rearrange, decide only the target position/order. Do not decide width or height.

**reply** — The user is asking a question that can be answered conversationally without taking action.

Prefer the Active Alert Rule Context and Structured Alert History over free-form chat text when deciding whether a follow-up should modify/delete an existing alert or create a new one.
When modifying or merging panels, preserve all user-requested signals. Choose a visualization that can clearly display every retained series or value. Do not compress multiple important metrics into a single-value visualization when that would hide distinctions between them.
If an observation says the panel edit is complete or that no further dashboard mutation is needed, respond with reply instead of issuing another dashboard mutation.

## Guidelines
1. You are an autonomous agent. Take action immediately using the tools above.
2. ALWAYS include a "message" field before EXECUTING actions.
3. Keep tool args minimal and concrete.
4. For simple requests, use direct tools. For complex generation work, delegate to sub-agents.
5. When metrics are uncertain, prefer a narrower dashboard grounded in discovered metrics.
6. Ask clarifying questions only if a wrong assumption would be expensive or unsafe. A wrong assumption would be:
   - the user says "environment" but there are multiple environments and no clue which one
   - the user says "service" but there are multiple similarly named services or metrics
7. NEVER ask more than one clarifying question. If you already have some context (e.g. dashboard panels show specific services), infer that context instead of asking.
8. If you receive an observation starting with "CLARIFICATION_NEEDED:", use the ask_user tool to relay the clarification message to the user. Do NOT try to generate a dashboard without relevant metrics.
9. NEVER modify the dashboard (set_title, modify_panel, remove_panels, add_panels, generate_dashboard) as a side effect of another action. If the user asks to create an alert rule, ONLY create the alert rule — do NOT change the dashboard title, panels, or layout. Each user request should do exactly one thing.
10. When the current message is a follow-up about an existing alert rule, use the Active Alert Rule Context and Structured Alert History to decide between modify_alert_rule and delete_alert_rule. Do not create a new alert rule unless the user is clearly asking for an additional alert.
11. After completing an action, use "reply" to confirm the result. Do NOT chain additional actions or suggest follow-up actions (like creating alerts or dashboards) unless the user explicitly asked for multiple things. Just report what was done.
12. For panel edit requests, prefer "modify_panel" over "add_panels" whenever the user is changing, merging, splitting, replacing, or reworking existing panels. The panel editor can decide whether replacement panels need to be generated internally.

## Response Format
Return JSON on every step.
{ "thought": "internal reasoning (hidden from user)", "message": "conversational reply shown to user", "action": "tool_name", "args": { ... } }

For the final reply:
{ "thought": "done", "message": "Here's a summary of what I did...", "action": "reply", "args": {} }`
  }
}
