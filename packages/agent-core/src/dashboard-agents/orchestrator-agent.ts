import { randomUUID } from 'node:crypto'
import { createLogger } from '@agentic-obs/common'
import type {
  DashboardSseEvent,
  DashboardAction,
  DashboardMessage,
  Dashboard,
  DashboardVariable,
} from '@agentic-obs/common'
import type {
  IDashboardAgentStore,
  IConversationStore,
  IInvestigationReportStore,
  IAlertRuleStore,
  DatasourceConfig,
} from './types.js'
import type { LLMGateway } from '@agentic-obs/llm-gateway'
import { DashboardGeneratorAgent } from './dashboard-generator-agent.js'
import { PanelAdderAgent } from './panel-adder-agent.js'
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
  alertRuleStore: IAlertRuleStore
  prometheusUrl: string | undefined
  prometheusHeaders: Record<string, string>
  /** All configured datasources - used to inform the LLM about available environments */
  allDatasources?: DatasourceConfig[]
  sendEvent: (event: DashboardSseEvent) => void
  /** Maximum total tokens per chat message. Default: 50000 */
  maxTokenBudget?: number
}

const MUTATION_ACTIONS = [
  'add_panels', 'remove_panels', 'modify_panel', 'rearrange',
  'add_variable', 'set_title', 'generate_dashboard', 'create_alert_rule',
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
  static readonly definition = agentRegistry.get('intent-router')!;

  private readonly actionExecutor: ActionExecutor
  private readonly generatorAgent: DashboardGeneratorAgent
  private readonly panelAdderAgent: PanelAdderAgent
  private readonly investigationAgent?: InvestigationAgent
  private readonly alertRuleAgent: AlertRuleAgent
  private readonly reactLoop: ReActLoop
  private readonly verifierAgent: VerifierAgent

  constructor(private deps: OrchestratorDeps) {
    this.actionExecutor = new ActionExecutor(deps.store, deps.sendEvent)

    const subAgentDeps = {
      gateway: deps.gateway,
      model: deps.model,
      prometheusUrl: deps.prometheusUrl,
      prometheusHeaders: deps.prometheusHeaders,
      sendEvent: deps.sendEvent,
    }

    this.generatorAgent = new DashboardGeneratorAgent(subAgentDeps)
    this.panelAdderAgent = new PanelAdderAgent(subAgentDeps)

    if (deps.prometheusUrl) {
      this.investigationAgent = new InvestigationAgent({
        gateway: deps.gateway,
        model: deps.model,
        prometheusUrl: deps.prometheusUrl,
        prometheusHeaders: deps.prometheusHeaders,
        sendEvent: deps.sendEvent,
      })
    }

    this.alertRuleAgent = new AlertRuleAgent({
      gateway: deps.gateway,
      model: deps.model,
      prometheusUrl: deps.prometheusUrl,
      prometheusHeaders: deps.prometheusHeaders,
    })

    this.reactLoop = new ReActLoop({
      gateway: deps.gateway,
      model: deps.model,
      sendEvent: deps.sendEvent,
      maxTokenBudget: deps.maxTokenBudget,
    })

    this.verifierAgent = new VerifierAgent()

    console.log(`[Orchestrator] init: prometheusUrl=${deps.prometheusUrl ? 'SET' : 'UNSET'}, investigationAgent=${this.investigationAgent ? 'YES' : 'NO'}`)
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

  async handleMessage(dashboardId: string, message: string): Promise<string> {
    this.emitAgentEvent(this.makeAgentEvent('agent.started', { dashboardId, message }));

    const dashboard = await this.deps.store.findById(dashboardId)
    if (!dashboard) {
      this.emitAgentEvent(this.makeAgentEvent('agent.failed', { reason: 'Dashboard not found' }));
      throw new Error(`Dashboard ${dashboardId} not found`)
    }

    const history = this.deps.conversationStore.getMessages(dashboardId)
    const systemPrompt = this.buildSystemPrompt(dashboard, history)

    try {
      const result = await this.reactLoop.runLoop(
        systemPrompt,
        message,
        (step) => this.executeAction(dashboardId, step),
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

  private async executeAction(dashboardId: string, step: ReActStep): Promise<string | null> {
    const { action, args } = step
    const agentDef = OrchestratorAgent.definition;

    // --- Tool boundary enforcement ---
    if (!agentDef.allowedTools.includes(action as AgentToolName)) {
      console.warn(`[Orchestrator] agent attempted undeclared tool "${action}" — blocked`);
      this.emitAgentEvent(this.makeAgentEvent('agent.tool_blocked', { tool: action, reason: 'undeclared_tool' }));
      return `Tool "${action}" is not permitted for this agent.`;
    }

    // --- Permission mode enforcement ---
    const permissionResult = checkPermission(agentDef.permissionMode, action);
    if (permissionResult === 'block') {
      console.warn(`[Orchestrator] mutation "${action}" blocked — agent is read_only`);
      this.emitAgentEvent(this.makeAgentEvent('agent.tool_blocked', { tool: action, reason: 'read_only' }));
      return `Action "${action}" is blocked: agent is in read-only mode.`;
    }
    if (permissionResult === 'approval_required') {
      console.info(`[Orchestrator] mutation "${action}" requires approval — emitting proposal`);
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
          const scopeArg = args.scope as string | undefined
          const scope = ['single', 'group', 'comprehensive'].includes(scopeArg as 'single' | 'group' | 'comprehensive')
            ? (scopeArg as 'single' | 'group' | 'comprehensive')
            : 'comprehensive'

          this.deps.sendEvent({
            type: 'tool_call',
            tool: 'generate_dashboard',
            args: { goal, scope },
            displayText: `Generating dashboard: ${goal} (${scope})`,
          })

          const currentDash = await this.deps.store.findById(dashboardId)
          if (!currentDash)
            throw new Error('Dashboard not found')

          const onGroupDone = async (panels: import('@agentic-obs/common').PanelConfig[]) => {
            await this.actionExecutor.execute(dashboardId, [{ type: 'add_panels', panels }])
          }

          const result = await this.generatorAgent.generate({
            goal,
            scope,
            existingPanels: currentDash.panels,
            existingVariables: currentDash.variables,
          }, onGroupDone)

          if (result.title) {
            await this.actionExecutor.execute(dashboardId, [{
              type: 'set_title',
              title: result.title,
              ...(result.description ? { description: result.description } : {}),
            }])
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
              prometheusUrl: this.deps.prometheusUrl,
              prometheusHeaders: this.deps.prometheusHeaders,
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

          let observationText: string
          if (verificationFailed) {
            observationText = `Generated ${result.panels.length} panels but verification FAILED — panels were rolled back. Issues found in generated queries or structure.`
            this.deps.sendEvent({
              type: 'tool_result',
              tool: 'generate_dashboard',
              summary: 'Dashboard generation rolled back due to verification failure',
              success: false,
            })
          } else {
            observationText = `Generated ${result.panels.length} panels`
              + (result.variables?.length ? ` and ${result.variables.length} variables` : '')
            this.deps.sendEvent({
              type: 'tool_result',
              tool: 'generate_dashboard',
              summary: observationText,
              success: result.panels.length > 0,
            })
          }
          this.emitAgentEvent(this.makeAgentEvent('agent.tool_completed', { tool: 'generate_dashboard', summary: observationText }));
          return observationText
        }

        case 'add_panels': {
          const goal = String(args.goal ?? '')
          this.deps.sendEvent({
            type: 'tool_call',
            tool: 'add_panels',
            args: { goal },
            displayText: `Adding panels: ${goal}`,
          })

          const currentDash = await this.deps.store.findById(dashboardId)
          if (!currentDash)
            throw new Error('Dashboard not found')

          // Discover available metrics and labels before generating panels
          let availableMetrics: string[] = []
          let labelsByMetric: Record<string, string[]> = {}
          if (this.deps.prometheusUrl) {
            try {
              const discoveryAgent = new DiscoveryAgent(
                this.deps.prometheusUrl,
                this.deps.prometheusHeaders ?? {},
                this.deps.sendEvent,
              )
              const discovery = await discoveryAgent.discover([goal])
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
              prometheusUrl: this.deps.prometheusUrl,
              prometheusHeaders: this.deps.prometheusHeaders,
            })
            this.deps.sendEvent({ type: 'verification_report', report: verificationReport })
            this.emitAgentEvent(this.makeAgentEvent('agent.artifact_verified', {
              tool: 'add_panels',
              status: verificationReport.status,
              summary: verificationReport.summary,
            }));
            if (verificationReport.status === 'failed') {
              addPanelsVerificationFailed = true
            }
          }

          const observationText
            = `Added ${result.panels.length} panel(s)`
            + (result.variables?.length ? ` and ${result.variables.length} variable(s)` : '')
            + (addPanelsVerificationFailed ? ' (verification FAILED)' : '')

          this.deps.sendEvent({
            type: 'tool_result',
            tool: 'add_panels',
            summary: observationText,
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

          await this.deps.store.update(dashboardId, { type: 'investigation' })
          await this.actionExecutor.execute(dashboardId, [{
            type: 'set_title',
            title: `Investigation: ${goal.length > 60 ? goal.slice(0, 60) + '...' : goal}`,
          }])

          this.deps.sendEvent({ type: 'investigation_report', report: result.report })

          // Run verification on the investigation report
          const verificationReport = await this.verifierAgent.verify('investigation_report', result.report, {
            prometheusUrl: this.deps.prometheusUrl,
            prometheusHeaders: this.deps.prometheusHeaders,
          })
          this.deps.sendEvent({ type: 'verification_report', report: verificationReport })
          this.emitAgentEvent(this.makeAgentEvent('agent.artifact_verified', {
            tool: 'investigate',
            status: verificationReport.status,
            summary: verificationReport.summary,
          }));

          this.deps.investigationReportStore.save({
            id: randomUUID(),
            dashboardId,
            goal,
            summary: result.summary,
            sections: result.report.sections,
            createdAt: new Date().toISOString(),
          })

          const observationText = result.summary
          this.deps.sendEvent({
            type: 'tool_result',
            tool: 'investigate',
            summary: `Investigation complete - ${result.panels.length} evidence panels added`,
            success: !verificationReport || verificationReport.status !== 'failed',
          })
          this.emitAgentEvent(this.makeAgentEvent('agent.tool_completed', { tool: 'investigate', summary: observationText }));
          return observationText
        }

        case 'remove_panels': {
          const panelIds = Array.isArray(args.panelIds) ? (args.panelIds as string[]) : []
          this.deps.sendEvent({
            type: 'tool_call',
            tool: 'remove_panels',
            args: { panelIds },
            displayText: `Removing ${panelIds.length} panel(s)`,
          })

          const removeAction: DashboardAction = { type: 'remove_panels', panelIds }
          await this.actionExecutor.execute(dashboardId, [removeAction])
          const observationText = `Removed ${panelIds.length} panel(s).`

          this.deps.sendEvent({
            type: 'tool_result',
            tool: 'remove_panels',
            summary: `Removed ${panelIds.length} panels`,
            success: true,
          })
          this.emitAgentEvent(this.makeAgentEvent('agent.tool_completed', { tool: 'remove_panels', summary: observationText }));
          return observationText
        }

        case 'modify_panel': {
          const panelId = String(args.panelId ?? '')
          const patch = (args.patch ?? {}) as Partial<Dashboard['panels'][number]>
          this.deps.sendEvent({
            type: 'tool_call',
            tool: 'modify_panel',
            args: { panelId, patch },
            displayText: `Modifying panel: ${panelId}`,
          })

          const modifyAction: DashboardAction = { type: 'modify_panel', panelId, patch }
          await this.actionExecutor.execute(dashboardId, [modifyAction])
          const observationText = `Modified panel ${panelId}.`

          this.deps.sendEvent({
            type: 'tool_result',
            tool: 'modify_panel',
            summary: `Panel ${panelId} modified`,
            success: true,
          })
          this.emitAgentEvent(this.makeAgentEvent('agent.tool_completed', { tool: 'modify_panel', summary: observationText }));
          return observationText
        }

        case 'rearrange': {
          const layout: Array<{ panelId: string, row: number, col: number, width: number, height: number }>
            = Array.isArray(args.layout)
              ? args.layout as Array<{ panelId: string, row: number, col: number, width: number, height: number }>
              : []

          this.deps.sendEvent({
            type: 'tool_call',
            tool: 'rearrange',
            args: { layout },
            displayText: `Rearranging ${layout.length} panel(s)`,
          })

          const rearrangeAction: DashboardAction = { type: 'rearrange', layout }
          await this.actionExecutor.execute(dashboardId, [rearrangeAction])
          const observationText = `Rearranged ${layout.length} panel(s).`

          this.deps.sendEvent({
            type: 'tool_result',
            tool: 'rearrange',
            summary: `Rearranged ${layout.length} panels`,
            success: true,
          })
          this.emitAgentEvent(this.makeAgentEvent('agent.tool_completed', { tool: 'rearrange', summary: observationText }));
          return observationText
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
            .flatMap((p) => (p.queries ?? []).map((q) => q.expr))
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

          const rule = this.deps.alertRuleStore.create({
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
          })

          const observationText = `Created alert rule "${rule.name}" (${rule.severity}, evaluating every ${rule.evaluationIntervalSec}s). Rule: ${rule.condition.query} ${rule.condition.operator} ${rule.condition.threshold} for ${rule.condition.forDurationSec}s.${generated.autoInvestigate ? ' Auto-investigation enabled on fire.' : ''}`
          this.deps.sendEvent({
            type: 'tool_result',
            tool: 'create_alert_rule',
            summary: `Alert rule "${rule.name}" created`,
            success: true,
          })
          this.emitAgentEvent(this.makeAgentEvent('agent.tool_completed', { tool: 'create_alert_rule', summary: observationText }));
          return observationText
        }

        default: {
          return `Unknown action "${action}" - skipping.`
        }
      }
    }
    catch (err) {
      const observationText = `Action "${action}" failed: ${err instanceof Error ? err.message : String(err)}`
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

  private buildSystemPrompt(dashboard: Dashboard, history: DashboardMessage[]): string {
    const panelsSummary = dashboard.panels.length > 0
      ? dashboard.panels.map((p) => `- [${p.id}] ${p.title} (${p.visualization})`).join('\n')
      : '(no panels yet)'

    const variablesSummary = (dashboard.variables ?? []).length > 0
      ? dashboard.variables.map((v) => `- $${v.name}: ${v.query ?? v.options?.join(', ') ?? 'join'}`).join('\n')
      : '(none)'

    const historySection = history.length > 0
      ? `\n## Recent Conversation History\n${history.slice(-10).map((m) => `- ${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}`).join('\n')}\n`
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
${historySection}${datasourceSection}

## Available Tools

## Sub-agents (for complex work - these handle research, discovery, and panel generation internally)
- generate_dashboard(goal: string, scope?: "single"|"group"|"comprehensive") -> full dashboard generation or rebuilding dashboards.
- add_panels(goal: string) -> add new panels to the existing dashboard. Use for granting or rebuilding dashboards.
- investigate(goal: string) -> investigate a production issue using Prometheus data; generates evidence panels for report view.
- create_alert_rule(prompt: string) -> create a Prometheus alert rule that notifies users when the user asks for alerting/troubleshooting conditions.

## Direct tools (immediate dashboard changes)
- remove_panels(panelIds: string[]) -> remove panels by ID
- modify_panel(panelId: string, patch: object) -> patch a panel's properties (title, queries, visualization, etc.)
- rearrange(layout: Array<{ panelId, row, col, width, height }>) -> change panel layout positions
- add_variable(variable: DashboardVariable) -> add a template variable
- set_title(title: string, description?: string) -> update dashboard title/description

## Terminal
- reply(text: string) -> Send final reply to user and end the loop
- ask_user(question: string) -> Ask the user a clarifying question and wait for their response. Use VERY sparingly.

## Intent Classification
CRITICAL: Classify the user's intent carefully. You have the ability to create alert rules via the create_alert_rule tool. NEVER tell the user you cannot set up alerts or notifications - use the create_alert_rule tool instead.

### Key distinction:
- generate_dashboard = user wants to BUILD/CREATE a monitoring dashboard (proactive setup)
- investigate = user is ASKING ABOUT a PROBLEM or wants to DIAGNOSE an issue (reactive troubleshooting)

Route to the appropriate tool:

### Create/rebuild dashboard (user explicitly wants to create or set up monitoring) -> generate_dashboard
Examples:
- "Create a dashboard for my AKS cluster" -> build me a monitoring dashboard
- "Set up observability for X" -> build a monitoring dashboard

### Investigate/troubleshoot (user describes a PROBLEM, asks why something is happening, or wants to diagnose) -> investigate
Examples:
- "Why are my server latency high?" -> investigate the error spike
- "What is causing high CPU?" -> debug the issue
NOTE: Any question starting with "why", "what's causing", "what's wrong", or describing a symptom/problem ALWAYS investigate, NOT generate_dashboard.
IMPORTANT: If the user describes a condition they want to be informed about in the future:
- "Notify me if CPU > 80% for 10 minutes" -> create_alert_rule
- "Create an alert when the pod restarts" -> create_alert_rule
- "Let me know if memory crosses threshold" -> create_alert_rule

### Receive a notification or be alerted when a metric crosses a threshold or a state occurs -> create_alert_rule
Patterns: the user specifies "alert/notify/condition threshold" to be monitored/detected/followed up. This includes any phrasing that implies "watch this for me and tell me when..."

### Add panels -> add_panels
- "Add a panel for 4xx rate" -> add new panel
- "Add panels for memory" -> add panels for memory

### Modify panels/layout -> use direct tools
- "Rename the CPU panel to..." -> modify_panel
- "Move panel X to the top-right" -> rearrange
- "Add namespace filter" -> add_variable
- "Set title to..." -> set_title
- "Can you explain what the dashboard is showing?" -> reply directly

## Guidelines
1. You are an autonomous agent. Default to acting, not asking.
2. ALWAYS include a "message" field before EXECUTING actions. Take action immediately using the tools above. Default to acting, not asking.
3. Keep tool args minimal and concrete.
4. For simple requests, use direct tools. For complex generation work, delegate to sub-agents.
5. Ask clarifying questions only if a wrong assumption would be expensive or unsafe. A wrong assumption would be:
   - the user says "environment" but there are multiple environments and no clue which one
   - the user says "service" but there are multiple similarly named services or metrics
6. Do NOT ask "How can we make a reasonable assumption?" Instead:
   - Create "AKS Cluster Overview dashboard" just do it with standard K8s metrics
   - Investigate the Redis error spike? clear enough -> investigate Redis immediately
   - Set CPU panel -> just add it, don't ask which CPU metric
7. NEVER ask more than one clarifying question. If you already have some context (e.g. dashboard panels show specific services), infer that context instead of asking.

## Response Format
Return JSON on every step.
{ "thought": "internal reasoning (hidden from user)", "message": "conversational reply shown to user", "action": "tool_name", "args": { ... } }

For the final reply:
{ "thought": "done", "message": "Here's a summary of what I did...", "action": "reply", "args": {} }`
  }
}
