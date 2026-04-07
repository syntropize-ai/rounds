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
import type { IMetricsAdapter } from '../adapters/index.js'
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
  metricsAdapter?: IMetricsAdapter
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
      metrics: deps.metricsAdapter,
      sendEvent: deps.sendEvent,
    }

    this.generatorAgent = new DashboardGeneratorAgent(subAgentDeps)
    this.panelAdderAgent = new PanelAdderAgent(subAgentDeps)

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

    console.log(`[Orchestrator] init: metricsAdapter=${deps.metricsAdapter ? 'SET' : 'UNSET'}, investigationAgent=${this.investigationAgent ? 'YES' : 'NO'}`)
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

    const history = await this.deps.conversationStore.getMessages(dashboardId)
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

          // Investigation type is now handled by the independent Investigation system
          await this.actionExecutor.execute(dashboardId, [{
            type: 'set_title',
            title: `Investigation: ${goal.length > 60 ? goal.slice(0, 60) + '...' : goal}`,
          }])

          this.deps.sendEvent({ type: 'investigation_report', report: result.report })

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

          const rule = await this.deps.alertRuleStore.create({
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
- generate_dashboard(goal: string) -> dashboard generation with research, metric discovery, and panel planning. The dashboard generator decides the appropriate breadth from the user's request and the available data. Use when the dashboard is empty or the user wants a new dashboard.
- add_panels(goal: string) -> add 1-3 specific panels to an EXISTING dashboard that already has panels. Only use for small incremental additions.
- investigate(goal: string) -> investigate a production issue using real data; generates evidence panels and investigation report.
- create_alert_rule(prompt: string) -> create an alert rule that notifies users when a metric crosses a threshold.

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

Classify the user's intent based on what they are trying to accomplish, not by matching keywords.

**investigate** — The user has a concern about something happening or that happened in their system. They want to understand, diagnose, or get answers about real-time or recent behavior. This applies regardless of whether the dashboard has panels.

**generate_dashboard** — The user wants to set up ongoing monitoring or visibility for a topic, service, or area. They are building a view for the future, not reacting to a current problem.

**add_panels** — The user wants to extend an existing dashboard that already has panels with a small addition.

**create_alert_rule** — The user wants to be notified when something happens in the future.

**Direct tools** (modify_panel, remove_panels, rearrange, add_variable, set_title) — The user wants to make a specific change to an existing panel or the dashboard structure.

**reply** — The user is asking a question that can be answered conversationally without taking action.

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
10. After completing an action, use "reply" to confirm the result. Do NOT chain additional actions unless the user explicitly asked for multiple things.

## Response Format
Return JSON on every step.
{ "thought": "internal reasoning (hidden from user)", "message": "conversational reply shown to user", "action": "tool_name", "args": { ... } }

For the final reply:
{ "thought": "done", "message": "Here's a summary of what I did...", "action": "reply", "args": {} }`
  }
}
