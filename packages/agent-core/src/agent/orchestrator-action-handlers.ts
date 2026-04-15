import { randomUUID } from 'node:crypto'
import type {
  DashboardAction,
  DashboardSseEvent,
} from '@agentic-obs/common'
import type { LLMGateway } from '@agentic-obs/llm-gateway'
import type { IMetricsAdapter, IWebSearchAdapter } from '../adapters/index.js'
import type { AgentEvent } from './agent-events.js'
import type {
  IDashboardAgentStore,
  IInvestigationReportStore,
  IInvestigationStore,
  IAlertRuleStore,
  DatasourceConfig,
} from './types.js'
import type { ActionExecutor } from './action-executor.js'
import type { AlertRuleAgent } from './alert-rule-agent.js'

/** Shared context passed to every action handler. */
export interface ActionContext {
  gateway: LLMGateway
  model: string
  store: IDashboardAgentStore
  investigationReportStore: IInvestigationReportStore
  investigationStore?: IInvestigationStore
  alertRuleStore: IAlertRuleStore
  metricsAdapter?: IMetricsAdapter
  webSearchAdapter?: IWebSearchAdapter
  allDatasources?: DatasourceConfig[]
  sendEvent: (event: DashboardSseEvent) => void

  actionExecutor: ActionExecutor
  alertRuleAgent: AlertRuleAgent

  emitAgentEvent(event: AgentEvent): void
  makeAgentEvent(type: AgentEvent['type'], metadata?: Record<string, unknown>): AgentEvent
  pushConversationAction(action: DashboardAction): void
  setNavigateTo(path: string): void
}

// ---------------------------------------------------------------------------
// Dashboard lifecycle
// ---------------------------------------------------------------------------

export async function handleDashboardCreate(
  ctx: ActionContext,
  args: Record<string, unknown>,
): Promise<string> {
  if (!ctx.store.create) {
    return 'Error: dashboard store does not support creation.'
  }

  const title = String(args.title ?? 'Untitled Dashboard')
  const description = String(args.description ?? '')
  const prompt = String(args.prompt ?? args.description ?? '')

  ctx.sendEvent({ type: 'tool_call', tool: 'dashboard.create', args: { title }, displayText: `Creating dashboard: "${title}"` })

  const dashboard = await ctx.store.create({
    title,
    description,
    prompt,
    userId: 'agent',
    datasourceIds: [],
  })

  const observationText = `Created dashboard "${dashboard.title}" (id: ${dashboard.id}).`
  ctx.sendEvent({ type: 'tool_result', tool: 'dashboard.create', summary: observationText, success: true })
  ctx.emitAgentEvent(ctx.makeAgentEvent('agent.tool_completed', { tool: 'dashboard.create', dashboardId: dashboard.id, summary: observationText }))
  return observationText
}

// ---------------------------------------------------------------------------
// Investigation lifecycle
// ---------------------------------------------------------------------------

export async function handleInvestigationCreate(
  ctx: ActionContext,
  args: Record<string, unknown>,
): Promise<string> {
  if (!ctx.investigationStore) {
    return 'Error: investigation store is not available.'
  }

  const question = String(args.question ?? '')
  if (!question) return 'Error: "question" is required.'

  ctx.sendEvent({ type: 'tool_call', tool: 'investigation.create', args: { question }, displayText: `Creating investigation: "${question.slice(0, 60)}"` })

  const investigation = await ctx.investigationStore.create({
    question,
    sessionId: randomUUID(),
    userId: 'agent',
  })

  const observationText = `Created investigation "${question.slice(0, 60)}" (id: ${investigation.id}).`
  ctx.sendEvent({ type: 'tool_result', tool: 'investigation.create', summary: observationText, success: true })
  ctx.emitAgentEvent(ctx.makeAgentEvent('agent.tool_completed', { tool: 'investigation.create', investigationId: investigation.id, summary: observationText }))
  return observationText
}

// ---------------------------------------------------------------------------
// Dashboard mutation primitives — model constructs panel configs directly
// ---------------------------------------------------------------------------

export async function handleDashboardAddPanels(
  ctx: ActionContext,
  args: Record<string, unknown>,
): Promise<string> {
  const dashboardId = String(args.dashboardId ?? '')
  if (!dashboardId) return 'Error: "dashboardId" is required.'
  const panels = args.panels as Array<Record<string, unknown>> | undefined
  if (!panels || !Array.isArray(panels) || panels.length === 0) {
    return 'Error: "panels" array is required with at least one panel config.'
  }

  ctx.sendEvent({ type: 'tool_call', tool: 'dashboard.add_panels', args: { count: panels.length }, displayText: `Adding ${panels.length} panel(s)` })

  const panelConfigs: import('@agentic-obs/common').PanelConfig[] = panels.map((p) => ({
    id: randomUUID(),
    title: String(p.title ?? 'Panel'),
    description: String(p.description ?? ''),
    visualization: (p.visualization ?? 'time_series') as import('@agentic-obs/common').PanelVisualization,
    queries: Array.isArray(p.queries) ? p.queries.map((q: Record<string, unknown>) => ({
      refId: String(q.refId ?? 'A'),
      expr: String(q.expr ?? ''),
      legendFormat: typeof q.legendFormat === 'string' ? q.legendFormat : undefined,
      instant: q.instant === true,
    })) : [],
    row: Number(p.row ?? 0),
    col: Number(p.col ?? 0),
    width: Number(p.width ?? 6),
    height: Number(p.height ?? 3),
    unit: typeof p.unit === 'string' ? p.unit : undefined,
    stackMode: typeof p.stackMode === 'string' ? p.stackMode as 'none' | 'normal' | 'percent' : undefined,
    fillOpacity: typeof p.fillOpacity === 'number' ? p.fillOpacity : undefined,
    decimals: typeof p.decimals === 'number' ? p.decimals : undefined,
    thresholds: Array.isArray(p.thresholds) ? p.thresholds as import('@agentic-obs/common').PanelThreshold[] : undefined,
  }))

  await ctx.actionExecutor.execute(dashboardId, [{ type: 'add_panels', panels: panelConfigs }])

  const observationText = `Added ${panelConfigs.length} panel(s): ${panelConfigs.map((p) => p.title).join(', ')}`
  ctx.sendEvent({ type: 'tool_result', tool: 'dashboard.add_panels', summary: observationText, success: true })
  ctx.emitAgentEvent(ctx.makeAgentEvent('agent.tool_completed', { tool: 'dashboard.add_panels', summary: observationText }))
  return observationText
}

export async function handleDashboardSetTitle(
  ctx: ActionContext,
  args: Record<string, unknown>,
): Promise<string> {
  const dashboardId = String(args.dashboardId ?? '')
  if (!dashboardId) return 'Error: "dashboardId" is required.'
  const title = String(args.title ?? '')
  const description = typeof args.description === 'string' ? args.description : undefined
  if (!title) return 'Error: "title" is required.'

  ctx.sendEvent({ type: 'tool_call', tool: 'dashboard.set_title', args: { title }, displayText: `Setting title: "${title}"` })
  await ctx.actionExecutor.execute(dashboardId, [{ type: 'set_title', title, ...(description !== undefined ? { description } : {}) }])

  const observationText = `Title set to "${title}".`
  ctx.sendEvent({ type: 'tool_result', tool: 'dashboard.set_title', summary: observationText, success: true })
  return observationText
}

export async function handleDashboardRemovePanels(
  ctx: ActionContext,
  args: Record<string, unknown>,
): Promise<string> {
  const dashboardId = String(args.dashboardId ?? '')
  if (!dashboardId) return 'Error: "dashboardId" is required.'
  const panelIds = Array.isArray(args.panelIds) ? args.panelIds.map(String) : []
  if (panelIds.length === 0) return 'Error: "panelIds" array is required.'

  ctx.sendEvent({ type: 'tool_call', tool: 'dashboard.remove_panels', args: { panelIds }, displayText: `Removing ${panelIds.length} panel(s)` })
  await ctx.actionExecutor.execute(dashboardId, [{ type: 'remove_panels', panelIds }])

  const observationText = `Removed ${panelIds.length} panel(s).`
  ctx.sendEvent({ type: 'tool_result', tool: 'dashboard.remove_panels', summary: observationText, success: true })
  return observationText
}

export async function handleDashboardModifyPanel(
  ctx: ActionContext,
  args: Record<string, unknown>,
): Promise<string> {
  const dashboardId = String(args.dashboardId ?? '')
  if (!dashboardId) return 'Error: "dashboardId" is required.'
  const panelId = String(args.panelId ?? '')
  if (!panelId) return 'Error: "panelId" is required.'
  const patch = { ...args } as Record<string, unknown>
  delete patch.panelId

  ctx.sendEvent({ type: 'tool_call', tool: 'dashboard.modify_panel', args: { panelId, patch }, displayText: `Modifying panel ${panelId}` })
  await ctx.actionExecutor.execute(dashboardId, [{ type: 'modify_panel', panelId, patch }])

  const observationText = `Modified panel ${panelId}.`
  ctx.sendEvent({ type: 'tool_result', tool: 'dashboard.modify_panel', summary: observationText, success: true })
  return observationText
}

export async function handleDashboardAddVariable(
  ctx: ActionContext,
  args: Record<string, unknown>,
): Promise<string> {
  const dashboardId = String(args.dashboardId ?? '')
  if (!dashboardId) return 'Error: "dashboardId" is required.'
  const variable = args.variable as import('@agentic-obs/common').DashboardVariable ?? {
    name: String(args.name ?? ''),
    label: String(args.label ?? args.name ?? ''),
    type: (args.type ?? 'query') as 'query' | 'custom' | 'datasource',
    query: typeof args.query === 'string' ? args.query : undefined,
    multi: args.multi === true,
    includeAll: args.includeAll === true,
  }
  if (!variable.name) return 'Error: variable "name" is required.'

  ctx.sendEvent({ type: 'tool_call', tool: 'dashboard.add_variable', args: { name: variable.name }, displayText: `Adding variable: $${variable.name}` })
  await ctx.actionExecutor.execute(dashboardId, [{ type: 'add_variable', variable }])

  const observationText = `Added variable $${variable.name}.`
  ctx.sendEvent({ type: 'tool_result', tool: 'dashboard.add_variable', summary: observationText, success: true })
  return observationText
}

// ---------------------------------------------------------------------------
// Alert rules (still uses AlertRuleAgent for PromQL generation)
// ---------------------------------------------------------------------------

export async function handleCreateAlertRule(
  ctx: ActionContext,
  args: Record<string, unknown>,
): Promise<string> {
  const prompt = String(args.prompt ?? args.goal ?? '')
  const dashboardId = String(args.dashboardId ?? '')
  ctx.sendEvent({
    type: 'tool_call',
    tool: 'create_alert_rule',
    args: { prompt },
    displayText: `Creating alert rule: ${prompt.slice(0, 60)}`,
  })

  const currentDash = dashboardId ? await ctx.store.findById(dashboardId) : undefined
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

  const result = await ctx.alertRuleAgent.generate(prompt, {
    dashboardId,
    dashboardTitle: currentDash?.title,
    existingQueries: existingQueries.length > 0 ? existingQueries : undefined,
    variables: variables.length > 0 ? variables : undefined,
  })
  const generated = result.rule

  // Upsert: if a rule with the same name exists, update it
  let rule: Record<string, unknown> | undefined
  let isUpdate = false
  if (ctx.alertRuleStore.findAll && ctx.alertRuleStore.update) {
    try {
      const existing = await ctx.alertRuleStore.findAll()
      const list = (Array.isArray(existing) ? existing : (existing as { list: unknown[] }).list ?? []) as Array<{ id: string; name: string }>
      const match = list.find((r) => r.name === generated.name)
      if (match) {
        rule = await ctx.alertRuleStore.update(match.id, {
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
    rule = await ctx.alertRuleStore.create({
      name: generated.name,
      description: generated.description,
      originalPrompt: prompt,
      condition: generated.condition,
      evaluationIntervalSec: generated.evaluationIntervalSec,
      severity: generated.severity,
      labels: { ...generated.labels, ...(dashboardId ? { dashboardId } : {}) },
      createdBy: 'llm',
    }) as Record<string, unknown>
  }

  const rc = rule.condition as Record<string, unknown>
  const verb = isUpdate ? 'Updated' : 'Created'
  ctx.pushConversationAction({
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
  const observationText = `${verb} alert rule "${rule.name}" (id: ${rule.id ?? 'unknown'}, ${rule.severity}, evaluating every ${rule.evaluationIntervalSec}s). Rule: ${rc.query} ${rc.operator} ${rc.threshold} for ${rc.forDurationSec}s.`
  ctx.sendEvent({ type: 'tool_result', tool: 'create_alert_rule', summary: `Alert rule "${rule.name}" ${verb.toLowerCase()}`, success: true })
  ctx.emitAgentEvent(ctx.makeAgentEvent('agent.tool_completed', { tool: 'create_alert_rule', summary: observationText }))
  return observationText
}

export async function handleModifyAlertRule(
  ctx: ActionContext,
  args: Record<string, unknown>,
): Promise<string> {
  const ruleId = String(args.ruleId ?? '')
  const patch = (args.patch ?? args) as Record<string, unknown>
  if (!ruleId) return 'Error: ruleId is required for modify_alert_rule.'
  if (!ctx.alertRuleStore.update) return 'Error: alert rule store does not support updates.'
  if (!ctx.alertRuleStore.findById) return 'Error: alert rule store does not support findById.'

  ctx.sendEvent({ type: 'tool_call', tool: 'modify_alert_rule', args: { ruleId, patch }, displayText: `Updating alert rule ${ruleId}...` })

  const existingRule = await ctx.alertRuleStore.findById(ruleId) as Record<string, unknown> | undefined
  if (!existingRule) return `Error: alert rule ${ruleId} not found.`

  const updatePatch: Record<string, unknown> = {}
  if (patch.severity) updatePatch.severity = patch.severity
  if (patch.evaluationIntervalSec) updatePatch.evaluationIntervalSec = patch.evaluationIntervalSec
  if (patch.name) updatePatch.name = patch.name

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

  const updatedRule = await ctx.alertRuleStore.update(ruleId, updatePatch) as Record<string, unknown> | undefined

  ctx.pushConversationAction({
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
  ctx.sendEvent({ type: 'tool_result', tool: 'modify_alert_rule', summary: observationText, success: true })
  ctx.emitAgentEvent(ctx.makeAgentEvent('agent.tool_completed', { tool: 'modify_alert_rule', summary: observationText }))
  return observationText
}

export async function handleDeleteAlertRule(
  ctx: ActionContext,
  args: Record<string, unknown>,
): Promise<string> {
  const ruleId = String(args.ruleId ?? '')
  if (!ruleId) return 'Error: ruleId is required for delete_alert_rule.'

  ctx.sendEvent({ type: 'tool_call', tool: 'delete_alert_rule', args: { ruleId }, displayText: `Deleting alert rule ${ruleId}...` })

  const existingRule = ctx.alertRuleStore.findById
    ? await ctx.alertRuleStore.findById(ruleId) as Record<string, unknown> | undefined
    : undefined

  if (ctx.alertRuleStore.delete) {
    await ctx.alertRuleStore.delete(ruleId)
  }

  ctx.pushConversationAction({ type: 'delete_alert_rule', ruleId })

  const deletedRuleName = String(existingRule?.name ?? 'the alert rule')
  const observationText = `Deleted "${deletedRuleName}".`
  ctx.sendEvent({ type: 'tool_result', tool: 'delete_alert_rule', summary: observationText, success: true })
  ctx.emitAgentEvent(ctx.makeAgentEvent('agent.tool_completed', { tool: 'delete_alert_rule', summary: observationText }))
  return observationText
}

// ---------------------------------------------------------------------------
// Prometheus primitive tools
// ---------------------------------------------------------------------------

export async function handlePrometheusQuery(ctx: ActionContext, args: Record<string, unknown>): Promise<string> {
  if (!ctx.metricsAdapter) return 'Error: No Prometheus datasource configured.'
  const expr = String(args.expr ?? '')
  if (!expr) return 'Error: "expr" is required.'

  ctx.sendEvent({ type: 'tool_call', tool: 'prometheus.query', args: { expr }, displayText: `Querying: ${expr.slice(0, 80)}` })
  try {
    const results = await ctx.metricsAdapter.instantQuery(expr)
    const summary = results.length === 0
      ? 'Query returned no data.'
      : results.slice(0, 20).map((s) => {
          const labelStr = Object.entries(s.labels).filter(([k]) => k !== '__name__').map(([k, v]) => `${k}="${v}"`).join(', ')
          return `${labelStr || s.labels.__name__ || 'series'}: ${s.value}`
        }).join('\n') + (results.length > 20 ? `\n... and ${results.length - 20} more series` : '')
    ctx.sendEvent({ type: 'tool_result', tool: 'prometheus.query', summary: `${results.length} series returned`, success: true })
    return summary
  } catch (err) {
    const msg = `Query failed: ${err instanceof Error ? err.message : String(err)}`
    ctx.sendEvent({ type: 'tool_result', tool: 'prometheus.query', summary: msg, success: false })
    return msg
  }
}

export async function handlePrometheusRangeQuery(ctx: ActionContext, args: Record<string, unknown>): Promise<string> {
  if (!ctx.metricsAdapter) return 'Error: No Prometheus datasource configured.'
  const expr = String(args.expr ?? '')
  if (!expr) return 'Error: "expr" is required.'
  const step = String(args.step ?? '60s')
  const durationMin = Number(args.duration_minutes ?? 60)
  const end = new Date()
  const start = new Date(end.getTime() - durationMin * 60_000)

  ctx.sendEvent({ type: 'tool_call', tool: 'prometheus.range_query', args: { expr, step, duration_minutes: durationMin }, displayText: `Range query: ${expr.slice(0, 60)}` })
  try {
    const results = await ctx.metricsAdapter.rangeQuery(expr, start, end, step)
    const summary = results.length === 0
      ? 'Range query returned no data.'
      : results.slice(0, 10).map((r) => {
          const labelStr = Object.entries(r.metric).filter(([k]) => k !== '__name__').map(([k, v]) => `${k}="${v}"`).join(', ')
          const lastVal = r.values.length > 0 ? r.values[r.values.length - 1]![1] : 'N/A'
          return `${labelStr || r.metric.__name__ || 'series'}: ${r.values.length} points, latest=${lastVal}`
        }).join('\n') + (results.length > 10 ? `\n... and ${results.length - 10} more series` : '')
    ctx.sendEvent({ type: 'tool_result', tool: 'prometheus.range_query', summary: `${results.length} series returned`, success: true })
    return summary
  } catch (err) {
    const msg = `Range query failed: ${err instanceof Error ? err.message : String(err)}`
    ctx.sendEvent({ type: 'tool_result', tool: 'prometheus.range_query', summary: msg, success: false })
    return msg
  }
}

export async function handlePrometheusLabels(ctx: ActionContext, args: Record<string, unknown>): Promise<string> {
  if (!ctx.metricsAdapter) return 'Error: No Prometheus datasource configured.'
  const metric = String(args.metric ?? '')
  if (!metric) return 'Error: "metric" is required.'
  ctx.sendEvent({ type: 'tool_call', tool: 'prometheus.labels', args: { metric }, displayText: `Listing labels for ${metric}` })
  try {
    const labels = await ctx.metricsAdapter.listLabels(metric)
    const summary = labels.length === 0 ? `No labels found for ${metric}.` : labels.join(', ')
    ctx.sendEvent({ type: 'tool_result', tool: 'prometheus.labels', summary: `${labels.length} labels`, success: true })
    return summary
  } catch (err) {
    const msg = `Failed to list labels: ${err instanceof Error ? err.message : String(err)}`
    ctx.sendEvent({ type: 'tool_result', tool: 'prometheus.labels', summary: msg, success: false })
    return msg
  }
}

export async function handlePrometheusLabelValues(ctx: ActionContext, args: Record<string, unknown>): Promise<string> {
  if (!ctx.metricsAdapter) return 'Error: No Prometheus datasource configured.'
  const label = String(args.label ?? '')
  if (!label) return 'Error: "label" is required.'
  ctx.sendEvent({ type: 'tool_call', tool: 'prometheus.label_values', args: { label }, displayText: `Listing values for label "${label}"` })
  try {
    const values = await ctx.metricsAdapter.listLabelValues(label)
    const summary = values.length === 0
      ? `No values found for label "${label}".`
      : values.slice(0, 50).join(', ') + (values.length > 50 ? ` ... and ${values.length - 50} more` : '')
    ctx.sendEvent({ type: 'tool_result', tool: 'prometheus.label_values', summary: `${values.length} values`, success: true })
    return summary
  } catch (err) {
    const msg = `Failed to list label values: ${err instanceof Error ? err.message : String(err)}`
    ctx.sendEvent({ type: 'tool_result', tool: 'prometheus.label_values', summary: msg, success: false })
    return msg
  }
}

export async function handlePrometheusSeries(ctx: ActionContext, args: Record<string, unknown>): Promise<string> {
  if (!ctx.metricsAdapter) return 'Error: No Prometheus datasource configured.'
  const patterns = Array.isArray(args.patterns) ? args.patterns.map(String) : [String(args.pattern ?? args.patterns ?? '')]
  if (patterns.length === 0 || !patterns[0]) return 'Error: "patterns" (array of match[] selectors) is required.'
  ctx.sendEvent({ type: 'tool_call', tool: 'prometheus.series', args: { patterns }, displayText: `Finding series matching: ${patterns.join(', ').slice(0, 60)}` })
  try {
    const series = await ctx.metricsAdapter.findSeries(patterns)
    const summary = series.length === 0
      ? 'No series matched.'
      : series.slice(0, 50).join('\n') + (series.length > 50 ? `\n... and ${series.length - 50} more` : '')
    ctx.sendEvent({ type: 'tool_result', tool: 'prometheus.series', summary: `${series.length} series found`, success: true })
    return summary
  } catch (err) {
    const msg = `Series search failed: ${err instanceof Error ? err.message : String(err)}`
    ctx.sendEvent({ type: 'tool_result', tool: 'prometheus.series', summary: msg, success: false })
    return msg
  }
}

export async function handlePrometheusMetadata(ctx: ActionContext, args: Record<string, unknown>): Promise<string> {
  if (!ctx.metricsAdapter) return 'Error: No Prometheus datasource configured.'
  const metrics = Array.isArray(args.metrics) ? args.metrics.map(String) : undefined
  ctx.sendEvent({ type: 'tool_call', tool: 'prometheus.metadata', args: { metrics: metrics ?? 'all' }, displayText: `Fetching metadata${metrics ? ` for ${metrics.length} metrics` : ''}` })
  try {
    const metadata = await ctx.metricsAdapter.fetchMetadata(metrics)
    const entries = Object.entries(metadata)
    const summary = entries.length === 0
      ? 'No metadata available.'
      : entries.slice(0, 30).map(([name, m]) => `${name} (${m.type}): ${m.help}`).join('\n')
        + (entries.length > 30 ? `\n... and ${entries.length - 30} more` : '')
    ctx.sendEvent({ type: 'tool_result', tool: 'prometheus.metadata', summary: `${entries.length} metrics`, success: true })
    return summary
  } catch (err) {
    const msg = `Metadata fetch failed: ${err instanceof Error ? err.message : String(err)}`
    ctx.sendEvent({ type: 'tool_result', tool: 'prometheus.metadata', summary: msg, success: false })
    return msg
  }
}

export async function handlePrometheusMetricNames(ctx: ActionContext): Promise<string> {
  if (!ctx.metricsAdapter) return 'Error: No Prometheus datasource configured.'
  ctx.sendEvent({ type: 'tool_call', tool: 'prometheus.metric_names', args: {}, displayText: 'Listing all metric names' })
  try {
    const names = await ctx.metricsAdapter.listMetricNames()
    const summary = names.length === 0
      ? 'No metrics found.'
      : `${names.length} metrics available.\n` + names.slice(0, 100).join('\n') + (names.length > 100 ? `\n... and ${names.length - 100} more` : '')
    ctx.sendEvent({ type: 'tool_result', tool: 'prometheus.metric_names', summary: `${names.length} metrics`, success: true })
    return summary
  } catch (err) {
    const msg = `Failed to list metrics: ${err instanceof Error ? err.message : String(err)}`
    ctx.sendEvent({ type: 'tool_result', tool: 'prometheus.metric_names', summary: msg, success: false })
    return msg
  }
}

export async function handlePrometheusValidate(ctx: ActionContext, args: Record<string, unknown>): Promise<string> {
  if (!ctx.metricsAdapter) return 'Error: No Prometheus datasource configured.'
  const expr = String(args.expr ?? '')
  if (!expr) return 'Error: "expr" is required.'
  ctx.sendEvent({ type: 'tool_call', tool: 'prometheus.validate', args: { expr }, displayText: `Validating: ${expr.slice(0, 60)}` })
  try {
    const result = await ctx.metricsAdapter.testQuery(expr)
    const summary = result.ok ? `Valid PromQL: ${expr}` : `Invalid PromQL: ${result.error ?? 'unknown error'}`
    ctx.sendEvent({ type: 'tool_result', tool: 'prometheus.validate', summary, success: result.ok })
    return summary
  } catch (err) {
    const msg = `Validation failed: ${err instanceof Error ? err.message : String(err)}`
    ctx.sendEvent({ type: 'tool_result', tool: 'prometheus.validate', summary: msg, success: false })
    return msg
  }
}

// ---------------------------------------------------------------------------
// Web search
// ---------------------------------------------------------------------------

export async function handleWebSearch(ctx: ActionContext, args: Record<string, unknown>): Promise<string> {
  if (!ctx.webSearchAdapter) return 'Error: No web search adapter configured.'
  const query = String(args.query ?? '')
  if (!query) return 'Error: "query" is required.'
  const maxResults = Number(args.max_results ?? 8)
  ctx.sendEvent({ type: 'tool_call', tool: 'web_search', args: { query }, displayText: `Searching: ${query.slice(0, 60)}` })
  try {
    const results = await ctx.webSearchAdapter.search(query, maxResults)
    const summary = results.length === 0
      ? 'No results found.'
      : results.map((r) => `${r.title ?? 'Result'}: ${r.snippet}${r.url ? ` (${r.url})` : ''}`).join('\n\n')
    ctx.sendEvent({ type: 'tool_result', tool: 'web_search', summary: `${results.length} results`, success: results.length > 0 })
    return summary
  } catch (err) {
    const msg = `Web search failed: ${err instanceof Error ? err.message : String(err)}`
    ctx.sendEvent({ type: 'tool_result', tool: 'web_search', summary: msg, success: false })
    return msg
  }
}
