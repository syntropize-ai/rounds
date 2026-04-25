import { randomUUID } from 'node:crypto'
import type {
  DashboardAction,
  DashboardSseEvent,
  Identity,
  InvestigationReportSection,
  PanelConfig,
  PanelVisualization,
  IFolderRepository,
  GrafanaFolder,
} from '@agentic-obs/common'
import { ac } from '@agentic-obs/common'
import type { LLMGateway } from '@agentic-obs/llm-gateway'
import type { AdapterRegistry, IWebSearchAdapter, SignalType } from '../adapters/index.js'
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
import type { IAccessControlService } from './types-permissions.js'
import { applyLayout, panelSize } from './layout-engine.js'

/** Shared context passed to every action handler. */
export interface ActionContext {
  gateway: LLMGateway
  model: string
  store: IDashboardAgentStore
  investigationReportStore: IInvestigationReportStore
  investigationStore?: IInvestigationStore
  alertRuleStore: IAlertRuleStore
  /** Folder repository — present when the SQLite folder service is wired.
   *  Optional so tests / in-memory setups can omit; folder.* handlers
   *  return a clear "folder backend not configured" observation if absent. */
  folderRepository?: IFolderRepository
  /**
   * Source-agnostic adapter registry. Required — the orchestrator resolves
   * every metrics/logs/changes call through it by `sourceId`. A session with
   * no backends configured still gets an empty registry so handlers can
   * return "unknown datasource" observations uniformly.
   */
  adapters: AdapterRegistry
  webSearchAdapter?: IWebSearchAdapter
  allDatasources?: DatasourceConfig[]
  sendEvent: (event: DashboardSseEvent) => void
  sessionId: string

  /**
   * The authenticated principal on whose behalf this handler runs (see §D1).
   * Handlers that list rows post-filter with `accessControl.filterByPermission`;
   * handlers that act on a specific UID rely on the pre-dispatch gate.
   */
  identity: Identity
  accessControl: IAccessControlService

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
    sessionId: ctx.sessionId,
    // Scope the new dashboard to the caller's org; the detail route
    // enforces workspaceId equality, so missing this field makes the
    // redirect land on "Dashboard not found" even though the row is in
    // the store. The non-agent POST /dashboards path already does this.
    workspaceId: ctx.identity.orgId,
  })

  // Navigate to the new dashboard so the user can see panels being added
  ctx.setNavigateTo(`/dashboards/${dashboard.id}`)

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
    sessionId: ctx.sessionId,
    userId: 'agent',
    // Same reason as dashboard.create: the GET route filters by
    // workspaceId; missing this field makes the investigation
    // unreachable even though the row is in the store.
    workspaceId: ctx.identity.orgId,
  })

  const observationText = `Created investigation "${question.slice(0, 60)}" (id: ${investigation.id}).`
  ctx.sendEvent({ type: 'tool_result', tool: 'investigation.create', summary: observationText, success: true })
  ctx.emitAgentEvent(ctx.makeAgentEvent('agent.tool_completed', { tool: 'investigation.create', investigationId: investigation.id, summary: observationText }))
  return observationText
}

// ---------------------------------------------------------------------------
// Investigation report section accumulator
// ---------------------------------------------------------------------------

const investigationSections = new Map<string, InvestigationReportSection[]>()

export async function handleInvestigationAddSection(
  ctx: ActionContext,
  args: Record<string, unknown>,
): Promise<string> {
  const investigationId = String(args.investigationId ?? '')
  if (!investigationId) return 'Error: "investigationId" is required.'

  const sectionType = String(args.type ?? 'text') as 'text' | 'evidence'
  const content = String(args.content ?? '')
  if (!content) return 'Error: "content" is required.'

  ctx.sendEvent({ type: 'tool_call', tool: 'investigation.add_section', args: { investigationId, type: sectionType }, displayText: `Adding ${sectionType} section to investigation` })

  const section: InvestigationReportSection = { type: sectionType, content }

  // Build panel config and capture snapshot for evidence sections
  if (sectionType === 'evidence' && args.panel && typeof args.panel === 'object') {
    const p = args.panel as Record<string, unknown>
    const viz = (p.visualization ?? 'time_series') as PanelVisualization
    const dims = panelSize(viz)
    const panelConfig: PanelConfig = {
      id: randomUUID(),
      title: String(p.title ?? 'Evidence'),
      description: typeof p.description === 'string' ? p.description : '',
      visualization: viz,
      queries: Array.isArray(p.queries) ? (p.queries as Record<string, unknown>[]).map((q) => ({
        refId: String(q.refId ?? 'A'),
        expr: String(q.expr ?? ''),
        legendFormat: typeof q.legendFormat === 'string' ? q.legendFormat : undefined,
        instant: q.instant === true,
      })) : [],
      row: 0,
      col: 0,
      width: dims.width,
      height: dims.height,
      unit: typeof p.unit === 'string' ? p.unit : undefined,
      // Visual polish hints — pass through whatever the agent emitted.
      ...(typeof p.sparkline === 'boolean' ? { sparkline: p.sparkline } : {}),
      ...(typeof p.colorMode === 'string' ? { colorMode: p.colorMode as PanelConfig['colorMode'] } : {}),
      ...(typeof p.graphMode === 'string' ? { graphMode: p.graphMode as PanelConfig['graphMode'] } : {}),
      ...(typeof p.lineWidth === 'number' ? { lineWidth: p.lineWidth } : {}),
      ...(typeof p.fillOpacity === 'number' ? { fillOpacity: p.fillOpacity } : {}),
      ...(Array.isArray(p.legendStats) ? { legendStats: p.legendStats as PanelConfig['legendStats'] } : {}),
      ...(typeof p.legendPlacement === 'string' ? { legendPlacement: p.legendPlacement as PanelConfig['legendPlacement'] } : {}),
      ...(typeof p.colorScale === 'string' ? { colorScale: p.colorScale as PanelConfig['colorScale'] } : {}),
    }

    // Capture snapshot data if any metrics adapter is available in the
    // registry. Evidence panels don't carry a sourceId today — pick the
    // first registered metrics datasource (preferring default) so snapshot
    // capture keeps working during the migration. Phase 2 may plumb the
    // sourceId through the panel config.
    const queries = panelConfig.queries ?? []
    const metricsSources = ctx.adapters.list({ signalType: 'metrics' })
    const chosenSource = metricsSources.find((d) => d.isDefault) ?? metricsSources[0]
    const evidenceAdapter = chosenSource ? ctx.adapters.metrics(chosenSource.id) : undefined
    if (evidenceAdapter && queries.length > 0) {
      try {
        const hasInstantQuery = queries.some((q) => q.instant)
        if (hasInstantQuery) {
          // Instant snapshot
          const results = await evidenceAdapter.instantQuery(queries[0]!.expr)
          // For stat panels with sparkline=true, also capture a range so the
          // saved investigation renders the trend without needing live data.
          // Failure here is non-fatal — we keep the instant snapshot either way.
          let sparkline: { timestamps: number[]; values: number[] } | undefined
          if (panelConfig.visualization === 'stat' && panelConfig.sparkline) {
            try {
              const end = new Date()
              const start = new Date(end.getTime() - 60 * 60_000)
              const sparkResults = await evidenceAdapter.rangeQuery(
                queries[0]!.expr,
                start,
                end,
                '60s',
              )
              const first = sparkResults[0]
              if (first && first.values.length > 0) {
                sparkline = {
                  timestamps: first.values.map(([ts]) => ts * 1000),
                  values: first.values.map(([, v]) => Number(v)).filter(Number.isFinite),
                }
              }
            } catch {
              // ignore — instant snapshot still wins
            }
          }
          panelConfig.snapshotData = {
            instant: {
              data: {
                result: results.map((r) => ({
                  metric: r.labels,
                  value: [r.timestamp, String(r.value)] as [number, string],
                })),
              },
            },
            ...(sparkline ? { sparkline } : {}),
            capturedAt: new Date().toISOString(),
          }
        } else {
          // Range snapshot
          const end = new Date()
          const start = new Date(end.getTime() - 60 * 60_000) // default 1 hour
          const step = '60s'
          const rangeResults = await Promise.all(
            queries.map(async (q) => {
              const results = await evidenceAdapter.rangeQuery(q.expr, start, end, step)
              return {
                refId: q.refId,
                series: results.map((r) => ({
                  labels: r.metric,
                  points: r.values.map(([ts, val]) => ({ ts, value: Number(val) })),
                })),
                totalSeries: results.length,
              }
            }),
          )
          panelConfig.snapshotData = {
            range: rangeResults,
            capturedAt: new Date().toISOString(),
          }
        }
      } catch {
        // Snapshot capture failed — proceed without snapshot
      }
    }

    section.panel = panelConfig
  }

  // Accumulate section
  const existing = investigationSections.get(investigationId) ?? []
  existing.push(section)
  investigationSections.set(investigationId, existing)

  const observationText = `Added ${sectionType} section to investigation ${investigationId} (${existing.length} sections total).`
  ctx.sendEvent({ type: 'tool_result', tool: 'investigation.add_section', summary: observationText, success: true })
  return observationText
}

export async function handleInvestigationComplete(
  ctx: ActionContext,
  args: Record<string, unknown>,
): Promise<string> {
  const investigationId = String(args.investigationId ?? '')
  if (!investigationId) return 'Error: "investigationId" is required.'
  const summary = String(args.summary ?? '')
  if (!summary) return 'Error: "summary" is required.'

  ctx.sendEvent({ type: 'tool_call', tool: 'investigation.complete', args: { investigationId }, displayText: `Completing investigation` })

  const sections = investigationSections.get(investigationId) ?? []

  // Save the report
  await ctx.investigationReportStore.save({
    id: randomUUID(),
    dashboardId: investigationId,
    goal: summary,
    summary,
    sections,
    createdAt: new Date().toISOString(),
  })

  // Update investigation status if store supports it
  if (ctx.investigationStore) {
    try {
      await ctx.investigationStore.updateStatus(investigationId, 'completed')
    } catch {
      // Status update failed — non-fatal
    }
  }

  // Clean up accumulated sections
  investigationSections.delete(investigationId)

  // Navigate to the investigation page
  ctx.setNavigateTo(`/investigations/${investigationId}`)

  const observationText = `Investigation completed and report saved with ${sections.length} sections. Summary: ${summary}`
  ctx.sendEvent({ type: 'tool_result', tool: 'investigation.complete', summary: observationText, success: true })
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

  type CommonPanel = import('@agentic-obs/common').PanelConfig
  // Panel sizing is NOT the agent's concern — every panel gets a viz-based
  // default from the layout-engine's panelSize(); users can drag to resize
  // in the UI afterward. Any width/height the agent emits is deliberately
  // ignored so proportions stay consistent across dashboards.
  const rawPanels: CommonPanel[] = panels.map((p) => {
    const viz = (p.visualization ?? 'time_series') as import('@agentic-obs/common').PanelVisualization
    return ({
    id: randomUUID(),
    title: String(p.title ?? 'Panel'),
    description: String(p.description ?? ''),
    visualization: viz,
    queries: Array.isArray(p.queries) ? p.queries.map((q: Record<string, unknown>) => ({
      refId: String(q.refId ?? 'A'),
      expr: String(q.expr ?? ''),
      legendFormat: typeof q.legendFormat === 'string' ? q.legendFormat : undefined,
      instant: q.instant === true,
    })) : [],
    row: 0,
    col: 0,
    // Placeholder dims — applyLayout() below replaces these with the
    // viz-specific defaults. Keeping placeholders here (vs leaving the field
    // undefined) avoids type narrowing churn downstream.
    width: 6,
    height: 3,
    unit: typeof p.unit === 'string' ? p.unit : undefined,
    stackMode: typeof p.stackMode === 'string' ? p.stackMode as 'none' | 'normal' | 'percent' : undefined,
    fillOpacity: typeof p.fillOpacity === 'number' ? p.fillOpacity : undefined,
    decimals: typeof p.decimals === 'number' ? p.decimals : undefined,
    thresholds: Array.isArray(p.thresholds) ? p.thresholds as import('@agentic-obs/common').PanelThreshold[] : undefined,
    // Visual polish hints from agent (default applied client-side when omitted)
    ...(typeof p.sparkline === 'boolean' ? { sparkline: p.sparkline } : {}),
    ...(typeof p.colorMode === 'string' ? { colorMode: p.colorMode as CommonPanel['colorMode'] } : {}),
    ...(typeof p.graphMode === 'string' ? { graphMode: p.graphMode as CommonPanel['graphMode'] } : {}),
    ...(typeof p.lineWidth === 'number' ? { lineWidth: p.lineWidth } : {}),
    ...(Array.isArray(p.legendStats) ? { legendStats: p.legendStats as CommonPanel['legendStats'] } : {}),
    ...(typeof p.legendPlacement === 'string' ? { legendPlacement: p.legendPlacement as CommonPanel['legendPlacement'] } : {}),
    ...(typeof p.colorScale === 'string' ? { colorScale: p.colorScale as CommonPanel['colorScale'] } : {}),
    ...(typeof p.showPoints === 'string' ? { showPoints: p.showPoints as CommonPanel['showPoints'] } : {}),
    ...(typeof p.yScale === 'string' ? { yScale: p.yScale as CommonPanel['yScale'] } : {}),
    ...(typeof p.collapseEmptyBuckets === 'boolean' ? { collapseEmptyBuckets: p.collapseEmptyBuckets } : {}),
    ...(typeof p.barGaugeMax === 'number' ? { barGaugeMax: p.barGaugeMax } : {}),
    ...(typeof p.barGaugeMode === 'string' ? { barGaugeMode: p.barGaugeMode as CommonPanel['barGaugeMode'] } : {}),
    ...(Array.isArray(p.annotations)
      ? {
          annotations: (p.annotations as Array<Record<string, unknown>>)
            .filter((a) => typeof a.time === 'number' && typeof a.label === 'string')
            .map((a) => ({
              time: a.time as number,
              label: a.label as string,
              ...(typeof a.color === 'string' ? { color: a.color } : {}),
            })),
        }
      : {}),
  })
  })

  // Apply auto-layout, then offset below existing panels
  const laidOut = applyLayout(rawPanels)
  const existing = await ctx.store.findById(dashboardId)
  const startRow = existing
    ? Math.max(0, ...existing.panels.map((p) => p.row + p.height))
    : 0
  const panelConfigs = laidOut.map((p) => ({ ...p, row: p.row + startRow }))

  await ctx.actionExecutor.execute(dashboardId, [{ type: 'add_panels', panels: panelConfigs }])

  // Flip the dashboard out of its initial 'generating' state once it has
  // real panels — the list page shows a yellow "GENERATING" badge until
  // status becomes 'ready', which looked wrong for a dashboard the user
  // can already open and see populated. Best-effort; older store shapes
  // may not implement updateStatus.
  if (ctx.store.updateStatus) {
    try {
      await ctx.store.updateStatus(dashboardId, 'ready')
    } catch {
      /* non-fatal — badge will stay 'generating' until next status write */
    }
  }

  const observationText = `Added ${panelConfigs.length} panel(s): ${panelConfigs.map((p) => p.title).join(', ')}`
  ctx.sendEvent({ type: 'tool_result', tool: 'dashboard.add_panels', summary: observationText, success: true })
  // Stream each new panel as a discrete `panel_added` event so the live
  // dashboard view (useDashboardChat) can splice it into the rendered grid
  // without a page refresh. Without these the chat hook only sees
  // `tool_result` and the user has to F5 to see the new panels.
  for (const panel of panelConfigs) {
    ctx.sendEvent({ type: 'panel_added', panel } as never)
  }
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
  // Stream `panel_removed` per id so the live view drops them without F5.
  for (const panelId of panelIds) {
    ctx.sendEvent({ type: 'panel_removed', panelId } as never)
  }
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
  // Stream `panel_modified` so the live view applies the patch without F5.
  ctx.sendEvent({ type: 'panel_modified', panelId, patch } as never)
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
      // Same reason as dashboard.create / investigation.create: the
      // list route filters by workspaceId, so an un-scoped row is
      // invisible even though it's in the store.
      workspaceId: ctx.identity.orgId,
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
// Datasource discovery (always allowed — required before metrics/logs/changes)
// ---------------------------------------------------------------------------

export async function handleDatasourcesList(
  ctx: ActionContext,
  args: Record<string, unknown>,
): Promise<string> {
  const signalType = typeof args.signalType === 'string' ? args.signalType : undefined
  const filter: { signalType?: SignalType } | undefined =
    signalType === 'metrics' || signalType === 'logs' || signalType === 'changes'
      ? { signalType }
      : undefined
  ctx.sendEvent({
    type: 'tool_call',
    tool: 'datasources.list',
    args: filter ? filter : {},
    displayText: filter ? `Listing ${filter.signalType} datasources` : 'Listing datasources',
  })

  const infos = ctx.adapters.list(filter)
  if (infos.length === 0) {
    const msg = filter
      ? `No ${filter.signalType} datasources are configured.`
      : 'No datasources are configured.'
    ctx.sendEvent({ type: 'tool_result', tool: 'datasources.list', summary: msg, success: true })
    return msg
  }
  const lines = infos.map((d) => {
    const tail = d.isDefault ? ' — default' : ''
    return `id: ${d.id} (${d.type}, ${d.signalType})${tail}`
  })
  const summary = lines.join('\n')
  ctx.sendEvent({
    type: 'tool_result',
    tool: 'datasources.list',
    summary: `${infos.length} datasource(s)`,
    success: true,
  })
  return summary
}

// ---------------------------------------------------------------------------
// Source-agnostic metrics primitives — each takes `sourceId` and resolves the
// concrete adapter through `ctx.adapters.metrics(sourceId)`.
// ---------------------------------------------------------------------------

function unknownMetricsSource(sourceId: string): string {
  return `Error: unknown metrics datasource '${sourceId}'. Call datasources.list to see available sources.`
}

function unknownLogsSource(sourceId: string): string {
  return `Error: unknown logs datasource '${sourceId}'. Call datasources.list to see available sources.`
}

export async function handleMetricsQuery(ctx: ActionContext, args: Record<string, unknown>): Promise<string> {
  const sourceId = String(args.sourceId ?? '')
  if (!sourceId) return 'Error: "sourceId" is required. Call datasources.list to see available sources.'
  const adapter = ctx.adapters.metrics(sourceId)
  if (!adapter) return unknownMetricsSource(sourceId)
  const expr = String(args.query ?? args.expr ?? '')
  if (!expr) return 'Error: "query" is required.'

  ctx.sendEvent({ type: 'tool_call', tool: 'metrics.query', args: { sourceId, query: expr }, displayText: `Querying ${sourceId}: ${expr.slice(0, 80)}` })
  try {
    const results = await adapter.instantQuery(expr)
    const summary = results.length === 0
      ? 'Query returned no data.'
      : results.slice(0, 20).map((s) => {
          const labelStr = Object.entries(s.labels).filter(([k]) => k !== '__name__').map(([k, v]) => `${k}="${v}"`).join(', ')
          return `${labelStr || s.labels.__name__ || 'series'}: ${s.value}`
        }).join('\n') + (results.length > 20 ? `\n... and ${results.length - 20} more series` : '')
    ctx.sendEvent({ type: 'tool_result', tool: 'metrics.query', summary: `${results.length} series returned`, success: true })
    return summary
  } catch (err) {
    const msg = `Query failed: ${err instanceof Error ? err.message : String(err)}`
    ctx.sendEvent({ type: 'tool_result', tool: 'metrics.query', summary: msg, success: false })
    return msg
  }
}

export async function handleMetricsRangeQuery(ctx: ActionContext, args: Record<string, unknown>): Promise<string> {
  const sourceId = String(args.sourceId ?? '')
  if (!sourceId) return 'Error: "sourceId" is required. Call datasources.list to see available sources.'
  const adapter = ctx.adapters.metrics(sourceId)
  if (!adapter) return unknownMetricsSource(sourceId)
  const expr = String(args.query ?? args.expr ?? '')
  if (!expr) return 'Error: "query" is required.'
  const step = String(args.step ?? '60s')

  // Two input modes: (start, end) explicit ISO strings, or duration_minutes.
  let start: Date
  let end: Date
  if (args.start && args.end) {
    start = new Date(String(args.start))
    end = new Date(String(args.end))
  } else {
    const durationMin = Number(args.duration_minutes ?? 60)
    end = new Date()
    start = new Date(end.getTime() - durationMin * 60_000)
  }

  ctx.sendEvent({ type: 'tool_call', tool: 'metrics.range_query', args: { sourceId, query: expr, step }, displayText: `Range query on ${sourceId}: ${expr.slice(0, 60)}` })
  try {
    const results = await adapter.rangeQuery(expr, start, end, step)
    const summary = results.length === 0
      ? 'Range query returned no data.'
      : results.slice(0, 10).map((r) => {
          const labelStr = Object.entries(r.metric).filter(([k]) => k !== '__name__').map(([k, v]) => `${k}="${v}"`).join(', ')
          const lastVal = r.values.length > 0 ? r.values[r.values.length - 1]![1] : 'N/A'
          return `${labelStr || r.metric.__name__ || 'series'}: ${r.values.length} points, latest=${lastVal}`
        }).join('\n') + (results.length > 10 ? `\n... and ${results.length - 10} more series` : '')
    ctx.sendEvent({ type: 'tool_result', tool: 'metrics.range_query', summary: `${results.length} series returned`, success: true })
    return summary
  } catch (err) {
    const msg = `Range query failed: ${err instanceof Error ? err.message : String(err)}`
    ctx.sendEvent({ type: 'tool_result', tool: 'metrics.range_query', summary: msg, success: false })
    return msg
  }
}

export async function handleMetricsLabels(ctx: ActionContext, args: Record<string, unknown>): Promise<string> {
  const sourceId = String(args.sourceId ?? '')
  if (!sourceId) return 'Error: "sourceId" is required. Call datasources.list to see available sources.'
  const adapter = ctx.adapters.metrics(sourceId)
  if (!adapter) return unknownMetricsSource(sourceId)
  const metric = String(args.metric ?? '')
  ctx.sendEvent({ type: 'tool_call', tool: 'metrics.labels', args: { sourceId, metric }, displayText: `Listing labels${metric ? ` for ${metric}` : ''}` })
  try {
    const labels = await adapter.listLabels(metric)
    const summary = labels.length === 0 ? `No labels found${metric ? ` for ${metric}` : ''}.` : labels.join(', ')
    ctx.sendEvent({ type: 'tool_result', tool: 'metrics.labels', summary: `${labels.length} labels`, success: true })
    return summary
  } catch (err) {
    const msg = `Failed to list labels: ${err instanceof Error ? err.message : String(err)}`
    ctx.sendEvent({ type: 'tool_result', tool: 'metrics.labels', summary: msg, success: false })
    return msg
  }
}

export async function handleMetricsLabelValues(ctx: ActionContext, args: Record<string, unknown>): Promise<string> {
  const sourceId = String(args.sourceId ?? '')
  if (!sourceId) return 'Error: "sourceId" is required. Call datasources.list to see available sources.'
  const adapter = ctx.adapters.metrics(sourceId)
  if (!adapter) return unknownMetricsSource(sourceId)
  const label = String(args.label ?? '')
  if (!label) return 'Error: "label" is required.'
  ctx.sendEvent({ type: 'tool_call', tool: 'metrics.label_values', args: { sourceId, label }, displayText: `Listing values for label "${label}"` })
  try {
    const values = await adapter.listLabelValues(label)
    const summary = values.length === 0
      ? `No values found for label "${label}".`
      : values.slice(0, 50).join(', ') + (values.length > 50 ? ` ... and ${values.length - 50} more` : '')
    ctx.sendEvent({ type: 'tool_result', tool: 'metrics.label_values', summary: `${values.length} values`, success: true })
    return summary
  } catch (err) {
    const msg = `Failed to list label values: ${err instanceof Error ? err.message : String(err)}`
    ctx.sendEvent({ type: 'tool_result', tool: 'metrics.label_values', summary: msg, success: false })
    return msg
  }
}

export async function handleMetricsSeries(ctx: ActionContext, args: Record<string, unknown>): Promise<string> {
  const sourceId = String(args.sourceId ?? '')
  if (!sourceId) return 'Error: "sourceId" is required. Call datasources.list to see available sources.'
  const adapter = ctx.adapters.metrics(sourceId)
  if (!adapter) return unknownMetricsSource(sourceId)
  const rawMatch = args.match ?? args.patterns ?? args.pattern
  const patterns = Array.isArray(rawMatch) ? rawMatch.map(String) : [String(rawMatch ?? '')]
  if (patterns.length === 0 || !patterns[0]) return 'Error: "match" (array of selectors) is required.'
  ctx.sendEvent({ type: 'tool_call', tool: 'metrics.series', args: { sourceId, match: patterns }, displayText: `Finding series matching: ${patterns.join(', ').slice(0, 60)}` })
  try {
    const series = await adapter.findSeries(patterns)
    const summary = series.length === 0
      ? 'No series matched.'
      : series.slice(0, 50).join('\n') + (series.length > 50 ? `\n... and ${series.length - 50} more` : '')
    ctx.sendEvent({ type: 'tool_result', tool: 'metrics.series', summary: `${series.length} series found`, success: true })
    return summary
  } catch (err) {
    const msg = `Series search failed: ${err instanceof Error ? err.message : String(err)}`
    ctx.sendEvent({ type: 'tool_result', tool: 'metrics.series', summary: msg, success: false })
    return msg
  }
}

export async function handleMetricsMetadata(ctx: ActionContext, args: Record<string, unknown>): Promise<string> {
  const sourceId = String(args.sourceId ?? '')
  if (!sourceId) return 'Error: "sourceId" is required. Call datasources.list to see available sources.'
  const adapter = ctx.adapters.metrics(sourceId)
  if (!adapter) return unknownMetricsSource(sourceId)
  const metric = typeof args.metric === 'string' ? args.metric : undefined
  const metrics = metric ? [metric] : (Array.isArray(args.metrics) ? args.metrics.map(String) : undefined)
  ctx.sendEvent({ type: 'tool_call', tool: 'metrics.metadata', args: { sourceId, metric: metric ?? metrics ?? 'all' }, displayText: `Fetching metadata${metric ? ` for ${metric}` : ''}` })
  try {
    const metadata = await adapter.fetchMetadata(metrics)
    const entries = Object.entries(metadata)
    const summary = entries.length === 0
      ? 'No metadata available.'
      : entries.slice(0, 30).map(([name, m]) => `${name} (${m.type}): ${m.help}`).join('\n')
        + (entries.length > 30 ? `\n... and ${entries.length - 30} more` : '')
    ctx.sendEvent({ type: 'tool_result', tool: 'metrics.metadata', summary: `${entries.length} metrics`, success: true })
    return summary
  } catch (err) {
    const msg = `Metadata fetch failed: ${err instanceof Error ? err.message : String(err)}`
    ctx.sendEvent({ type: 'tool_result', tool: 'metrics.metadata', summary: msg, success: false })
    return msg
  }
}

export async function handleMetricsMetricNames(ctx: ActionContext, args: Record<string, unknown> = {}): Promise<string> {
  const sourceId = String(args.sourceId ?? '')
  if (!sourceId) return 'Error: "sourceId" is required. Call datasources.list to see available sources.'
  const adapter = ctx.adapters.metrics(sourceId)
  if (!adapter) return unknownMetricsSource(sourceId)
  const filter = typeof args.match === 'string'
    ? args.match.toLowerCase()
    : typeof args.filter === 'string'
      ? args.filter.toLowerCase()
      : undefined

  ctx.sendEvent({ type: 'tool_call', tool: 'metrics.metric_names', args: { sourceId, ...(filter ? { match: filter } : {}) }, displayText: filter ? `Searching metrics matching "${filter}"` : 'Listing metric names' })
  try {
    const allNames = await adapter.listMetricNames()
    const totalCount = allNames.length

    let names: string[]
    if (filter) {
      names = allNames.filter((n) => n.toLowerCase().includes(filter))
    } else if (totalCount <= 500) {
      names = allNames
    } else {
      const sample = allNames.slice(0, 50)
      const summary = `${totalCount} metrics available (too many to list). Showing first 50:\n${sample.join('\n')}\n\nUse metrics.metric_names({ sourceId, match: "keyword" }) to search for specific metrics.`
      ctx.sendEvent({ type: 'tool_result', tool: 'metrics.metric_names', summary: `${totalCount} metrics (sampled)`, success: true })
      return summary
    }

    const summary = names.length === 0
      ? filter ? `No metrics matching "${filter}" (${totalCount} total metrics in cluster).` : 'No metrics found.'
      : `${names.length} metrics${filter ? ` matching "${filter}"` : ''} (${totalCount} total).\n` + names.join('\n')
    ctx.sendEvent({ type: 'tool_result', tool: 'metrics.metric_names', summary: `${names.length} metrics`, success: true })
    return summary
  } catch (err) {
    const msg = `Failed to list metrics: ${err instanceof Error ? err.message : String(err)}`
    ctx.sendEvent({ type: 'tool_result', tool: 'metrics.metric_names', summary: msg, success: false })
    return msg
  }
}

export async function handleMetricsValidate(ctx: ActionContext, args: Record<string, unknown>): Promise<string> {
  const sourceId = String(args.sourceId ?? '')
  if (!sourceId) return 'Error: "sourceId" is required. Call datasources.list to see available sources.'
  const adapter = ctx.adapters.metrics(sourceId)
  if (!adapter) return unknownMetricsSource(sourceId)
  const expr = String(args.query ?? args.expr ?? '')
  if (!expr) return 'Error: "query" is required.'
  ctx.sendEvent({ type: 'tool_call', tool: 'metrics.validate', args: { sourceId, query: expr }, displayText: `Validating: ${expr.slice(0, 60)}` })
  try {
    const result = await adapter.testQuery(expr)
    const summary = result.ok ? `Valid query: ${expr}` : `Invalid query: ${result.error ?? 'unknown error'}`
    ctx.sendEvent({ type: 'tool_result', tool: 'metrics.validate', summary, success: result.ok })
    return summary
  } catch (err) {
    const msg = `Validation failed: ${err instanceof Error ? err.message : String(err)}`
    ctx.sendEvent({ type: 'tool_result', tool: 'metrics.validate', summary: msg, success: false })
    return msg
  }
}

// ---------------------------------------------------------------------------
// Source-agnostic logs primitives — each takes `sourceId` and resolves the
// concrete adapter through `ctx.adapters.logs(sourceId)`.
// ---------------------------------------------------------------------------

const LOGS_QUERY_MAX_CHARS = 2000

export async function handleLogsQuery(ctx: ActionContext, args: Record<string, unknown>): Promise<string> {
  const sourceId = String(args.sourceId ?? '')
  if (!sourceId) return 'Error: "sourceId" is required. Call datasources.list to see available sources.'
  const adapter = ctx.adapters.logs(sourceId)
  if (!adapter) return unknownLogsSource(sourceId)
  const query = String(args.query ?? '')
  if (!query) return 'Error: "query" is required (backend-native — e.g. LogQL for Loki).'
  if (!args.start || !args.end) return 'Error: "start" and "end" (ISO-8601 timestamps) are required.'
  const start = new Date(String(args.start))
  const end = new Date(String(args.end))
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
    return 'Error: "start" / "end" must be valid ISO-8601 timestamps.'
  }
  const limit = typeof args.limit === 'number' ? Math.max(1, Math.min(1000, args.limit)) : undefined

  ctx.sendEvent({
    type: 'tool_call',
    tool: 'logs.query',
    args: { sourceId, query, limit },
    displayText: `Querying logs on ${sourceId}: ${query.slice(0, 60)}`,
  })
  try {
    const result = await adapter.query({ query, start, end, ...(limit !== undefined ? { limit } : {}) })
    if (result.entries.length === 0) {
      const msg = 'Logs query returned no entries.'
      ctx.sendEvent({ type: 'tool_result', tool: 'logs.query', summary: msg, success: true })
      return msg
    }
    // Format: `[ts] {k=v, k=v} message` — truncate the whole blob to keep the
    // observation reasonable even when the backend returns many rows.
    const lines: string[] = []
    let shown = 0
    let totalLen = 0
    for (const e of result.entries) {
      const labelStr = Object.entries(e.labels).map(([k, v]) => `${k}=${v}`).join(',')
      const line = `[${e.timestamp}]${labelStr ? ` {${labelStr}}` : ''} ${e.message}`
      if (totalLen + line.length > LOGS_QUERY_MAX_CHARS) break
      lines.push(line)
      totalLen += line.length + 1
      shown += 1
    }
    const truncated = shown < result.entries.length
    const header = truncated
      ? `${shown} of ${result.entries.length} log entries (truncated):`
      : `${result.entries.length} log entries:`
    const partialTail = result.partial ? '\n(Backend indicated results were partial — narrow the time window or add filters for completeness.)' : ''
    const warnTail = result.warnings?.length ? `\nWarnings: ${result.warnings.join('; ')}` : ''
    const summary = `${header}\n${lines.join('\n')}${partialTail}${warnTail}`
    ctx.sendEvent({ type: 'tool_result', tool: 'logs.query', summary: `${result.entries.length} entries`, success: true })
    return summary
  } catch (err) {
    const msg = `Logs query failed: ${err instanceof Error ? err.message : String(err)}`
    ctx.sendEvent({ type: 'tool_result', tool: 'logs.query', summary: msg, success: false })
    return msg
  }
}

export async function handleLogsLabels(ctx: ActionContext, args: Record<string, unknown>): Promise<string> {
  const sourceId = String(args.sourceId ?? '')
  if (!sourceId) return 'Error: "sourceId" is required. Call datasources.list to see available sources.'
  const adapter = ctx.adapters.logs(sourceId)
  if (!adapter) return unknownLogsSource(sourceId)
  ctx.sendEvent({ type: 'tool_call', tool: 'logs.labels', args: { sourceId }, displayText: `Listing log labels on ${sourceId}` })
  try {
    const labels = await adapter.listLabels()
    const summary = labels.length === 0 ? 'No log labels available.' : labels.join(', ')
    ctx.sendEvent({ type: 'tool_result', tool: 'logs.labels', summary: `${labels.length} labels`, success: true })
    return summary
  } catch (err) {
    const msg = `Failed to list log labels: ${err instanceof Error ? err.message : String(err)}`
    ctx.sendEvent({ type: 'tool_result', tool: 'logs.labels', summary: msg, success: false })
    return msg
  }
}

export async function handleLogsLabelValues(ctx: ActionContext, args: Record<string, unknown>): Promise<string> {
  const sourceId = String(args.sourceId ?? '')
  if (!sourceId) return 'Error: "sourceId" is required. Call datasources.list to see available sources.'
  const adapter = ctx.adapters.logs(sourceId)
  if (!adapter) return unknownLogsSource(sourceId)
  const label = String(args.label ?? '')
  if (!label) return 'Error: "label" is required.'
  ctx.sendEvent({ type: 'tool_call', tool: 'logs.label_values', args: { sourceId, label }, displayText: `Listing values for log label "${label}"` })
  try {
    const values = await adapter.listLabelValues(label)
    const summary = values.length === 0
      ? `No values found for label "${label}".`
      : values.slice(0, 50).join(', ') + (values.length > 50 ? ` ... and ${values.length - 50} more` : '')
    ctx.sendEvent({ type: 'tool_result', tool: 'logs.label_values', summary: `${values.length} values`, success: true })
    return summary
  } catch (err) {
    const msg = `Failed to list log label values: ${err instanceof Error ? err.message : String(err)}`
    ctx.sendEvent({ type: 'tool_result', tool: 'logs.label_values', summary: msg, success: false })
    return msg
  }
}

// ---------------------------------------------------------------------------
// Recent change events — deploys / config rollouts / incidents / feature flags
// ---------------------------------------------------------------------------

export async function handleChangesListRecent(
  ctx: ActionContext,
  args: Record<string, unknown>,
): Promise<string> {
  const explicitSource = typeof args.sourceId === 'string' && args.sourceId ? args.sourceId : undefined
  let sourceId = explicitSource
  if (!sourceId) {
    const firstChange = ctx.adapters.list({ signalType: 'changes' })[0]
    sourceId = firstChange?.id
  }
  if (!sourceId) {
    const msg = 'No change-event datasource configured. Call datasources.list to see available sources.'
    ctx.sendEvent({ type: 'tool_result', tool: 'changes.list_recent', summary: msg, success: false })
    return msg
  }
  const adapter = ctx.adapters.changes(sourceId)
  if (!adapter) {
    const msg = `Error: unknown changes datasource '${sourceId}'. Call datasources.list to see available sources.`
    ctx.sendEvent({ type: 'tool_result', tool: 'changes.list_recent', summary: msg, success: false })
    return msg
  }

  const service = typeof args.service === 'string' && args.service ? args.service : undefined
  const windowMinutes = typeof args.window_minutes === 'number'
    ? args.window_minutes
    : typeof args.windowMinutes === 'number' ? args.windowMinutes : 60

  ctx.sendEvent({
    type: 'tool_call',
    tool: 'changes.list_recent',
    args: { sourceId, service, window_minutes: windowMinutes },
    displayText: service ? `Recent changes for ${service} (last ${windowMinutes}m)` : `Recent changes (last ${windowMinutes}m)`,
  })

  try {
    const records = await adapter.listRecent({
      windowMinutes,
      ...(service ? { service } : {}),
    })
    if (records.length === 0) {
      const msg = service
        ? `No changes for ${service} in the last ${windowMinutes} minute(s).`
        : `No changes in the last ${windowMinutes} minute(s).`
      ctx.sendEvent({ type: 'tool_result', tool: 'changes.list_recent', summary: msg, success: true })
      return msg
    }
    const bullets = records.slice(0, 30).map((r) =>
      `- [${r.at}] ${r.service} (${r.kind}): ${r.summary}`,
    )
    const summary = `${records.length} change(s)${service ? ` for ${service}` : ''} in last ${windowMinutes}m:\n${bullets.join('\n')}${records.length > 30 ? `\n... and ${records.length - 30} more` : ''}`
    ctx.sendEvent({ type: 'tool_result', tool: 'changes.list_recent', summary: `${records.length} changes`, success: true })
    return summary
  } catch (err) {
    const msg = `Failed to list recent changes: ${err instanceof Error ? err.message : String(err)}`
    ctx.sendEvent({ type: 'tool_result', tool: 'changes.list_recent', summary: msg, success: false })
    return msg
  }
}

// ---------------------------------------------------------------------------
// Resource discovery (list/search existing artifacts)
// ---------------------------------------------------------------------------

function matchesFilter(text: string | undefined, filter: string | undefined): boolean {
  if (!filter) return true
  if (!text) return false
  return text.toLowerCase().includes(filter.toLowerCase())
}

export async function handleDashboardList(
  ctx: ActionContext,
  args: Record<string, unknown>,
): Promise<string> {
  if (!ctx.store.findAll) {
    return 'Error: dashboard store does not support listing.'
  }
  const filter = typeof args.filter === 'string' ? args.filter : undefined
  const limit = typeof args.limit === 'number' ? args.limit : 50
  ctx.sendEvent({
    type: 'tool_call',
    tool: 'dashboard.list',
    args: filter ? { filter } : {},
    displayText: filter ? `Searching dashboards matching "${filter}"` : 'Listing dashboards',
  })

  try {
    const allRaw = await ctx.store.findAll()
    // D10 — post-filter to the rows the caller can see. The pre-dispatch gate
    // confirmed they can list SOMETHING; filterByPermission then narrows the
    // set per-row against `dashboards:read` on that UID.
    const all = await ctx.accessControl.filterByPermission(
      ctx.identity,
      allRaw,
      (d) => ac.eval(
        'dashboards:read',
        `dashboards:uid:${(d as unknown as { id?: string }).id ?? ''}`,
      ),
    )
    const filtered = all.filter((d) => matchesFilter(d.title, filter) || matchesFilter(d.description, filter))
    if (filtered.length === 0) {
      const msg = filter
        ? `No dashboards match "${filter}" (${all.length} total).`
        : 'No dashboards found.'
      ctx.sendEvent({ type: 'tool_result', tool: 'dashboard.list', summary: msg, success: true })
      return msg
    }
    const lines = filtered.slice(0, limit).map((d) => {
      const id = (d as unknown as { id?: string }).id ?? 'unknown'
      const desc = d.description ? ` — ${d.description.slice(0, 80)}` : ''
      return `- [${id}] "${d.title}"${desc}`
    })
    const summary = `${filtered.length} dashboard(s)${filter ? ` matching "${filter}"` : ''}:\n${lines.join('\n')}`
    ctx.sendEvent({
      type: 'tool_result',
      tool: 'dashboard.list',
      summary: `${filtered.length} dashboards found`,
      success: true,
    })
    return summary
  } catch (err) {
    const msg = `Failed to list dashboards: ${err instanceof Error ? err.message : String(err)}`
    ctx.sendEvent({ type: 'tool_result', tool: 'dashboard.list', summary: msg, success: false })
    return msg
  }
}

export async function handleInvestigationList(
  ctx: ActionContext,
  args: Record<string, unknown>,
): Promise<string> {
  if (!ctx.investigationStore?.findAll) {
    return 'Error: investigation store does not support listing.'
  }
  const filter = typeof args.filter === 'string' ? args.filter : undefined
  const limit = typeof args.limit === 'number' ? args.limit : 50
  ctx.sendEvent({
    type: 'tool_call',
    tool: 'investigation.list',
    args: filter ? { filter } : {},
    displayText: filter ? `Searching investigations matching "${filter}"` : 'Listing investigations',
  })

  try {
    const allRaw = await ctx.investigationStore.findAll()
    const all = await ctx.accessControl.filterByPermission(
      ctx.identity,
      allRaw,
      (inv) => ac.eval(
        'investigations:read',
        `investigations:uid:${inv.id ?? ''}`,
      ),
    )
    const filtered = all.filter((inv) => matchesFilter(inv.intent, filter))
    if (filtered.length === 0) {
      const msg = filter
        ? `No investigations match "${filter}" (${all.length} total).`
        : 'No investigations found.'
      ctx.sendEvent({ type: 'tool_result', tool: 'investigation.list', summary: msg, success: true })
      return msg
    }
    const lines = filtered.slice(0, limit).map((inv) => {
      const id = inv.id ?? 'unknown'
      const status = inv.status ?? ''
      const intent = inv.intent ?? '(no intent)'
      return `- [${id}]${status ? ` (${status})` : ''} "${intent.slice(0, 100)}"`
    })
    const summary = `${filtered.length} investigation(s)${filter ? ` matching "${filter}"` : ''}:\n${lines.join('\n')}`
    ctx.sendEvent({
      type: 'tool_result',
      tool: 'investigation.list',
      summary: `${filtered.length} investigations found`,
      success: true,
    })
    return summary
  } catch (err) {
    const msg = `Failed to list investigations: ${err instanceof Error ? err.message : String(err)}`
    ctx.sendEvent({ type: 'tool_result', tool: 'investigation.list', summary: msg, success: false })
    return msg
  }
}

export async function handleAlertRuleList(
  ctx: ActionContext,
  args: Record<string, unknown>,
): Promise<string> {
  if (!ctx.alertRuleStore.findAll) {
    return 'Error: alert rule store does not support listing.'
  }
  const filter = typeof args.filter === 'string' ? args.filter : undefined
  ctx.sendEvent({
    type: 'tool_call',
    tool: 'alert_rule.list',
    args: filter ? { filter } : {},
    displayText: filter ? `Searching alert rules matching "${filter}"` : 'Listing alert rules',
  })

  try {
    const result = await ctx.alertRuleStore.findAll()
    const rawList = (Array.isArray(result) ? result : (result as { list?: unknown[] }).list ?? []) as Array<{
      id: string
      name: string
      severity: string
      condition: { query: string; operator: string; threshold: number }
    }>
    const list = await ctx.accessControl.filterByPermission(
      ctx.identity,
      rawList,
      (r) => ac.eval(
        'alert.rules:read',
        `alert.rules:uid:${r.id ?? ''}`,
      ),
    )
    const filtered = list.filter((r) => matchesFilter(r.name, filter))
    if (filtered.length === 0) {
      const msg = filter
        ? `No alert rules match "${filter}" (${list.length} total).`
        : 'No alert rules found.'
      ctx.sendEvent({ type: 'tool_result', tool: 'alert_rule.list', summary: msg, success: true })
      return msg
    }
    const lines = filtered.map((r) => {
      const c = r.condition ?? ({} as Record<string, unknown>)
      return `- [${r.id}] "${r.name}" (${r.severity}) — ${c.query ?? ''} ${c.operator ?? ''} ${c.threshold ?? ''}`
    })
    const summary = `${filtered.length} alert rule(s)${filter ? ` matching "${filter}"` : ''}:\n${lines.join('\n')}`
    ctx.sendEvent({
      type: 'tool_result',
      tool: 'alert_rule.list',
      summary: `${filtered.length} alert rules found`,
      success: true,
    })
    return summary
  } catch (err) {
    const msg = `Failed to list alert rules: ${err instanceof Error ? err.message : String(err)}`
    ctx.sendEvent({ type: 'tool_result', tool: 'alert_rule.list', summary: msg, success: false })
    return msg
  }
}

// ---------------------------------------------------------------------------
// Alert rule history — recent firing/resolution events for annotation overlays
// ---------------------------------------------------------------------------

interface RawHistoryEntry {
  id?: string
  ruleId?: string
  ruleName?: string
  fromState?: string
  toState?: string
  value?: number
  threshold?: number
  timestamp?: string
}

const SEVERITY_COLOR: Record<string, string> = {
  critical: '#ff6e84',
  high: '#f07934',
  medium: '#e2b007',
  low: '#3e7bfa',
}

export async function handleAlertRuleHistory(
  ctx: ActionContext,
  args: Record<string, unknown>,
): Promise<string> {
  const ruleId = typeof args.ruleId === 'string' ? args.ruleId : undefined
  const sinceMinutes = typeof args.sinceMinutes === 'number' ? args.sinceMinutes : 60
  const limit = typeof args.limit === 'number' ? args.limit : 50

  ctx.sendEvent({
    type: 'tool_call',
    tool: 'alert_rule.history',
    args: { ruleId, sinceMinutes, limit },
    displayText: ruleId
      ? `Fetching history for rule ${ruleId} (last ${sinceMinutes} min)`
      : `Fetching alert history (last ${sinceMinutes} min)`,
  })

  // Both methods are optional; bail with a helpful message instead of throwing
  // so the agent can decide whether to retry or skip annotations.
  const fetcher = ruleId
    ? ctx.alertRuleStore.getHistory?.bind(ctx.alertRuleStore, ruleId, limit)
    : ctx.alertRuleStore.getAllHistory?.bind(ctx.alertRuleStore, limit)
  if (!fetcher) {
    const msg = 'Alert history is not available from this store; skip annotations.'
    ctx.sendEvent({ type: 'tool_result', tool: 'alert_rule.history', summary: msg, success: false })
    return msg
  }

  // Severity lookup is best-effort: if the store lists rules, we can color
  // each annotation by the rule's severity. Failure here is not fatal.
  const severityByRule = new Map<string, string>()
  try {
    if (ctx.alertRuleStore.findAll) {
      const rules = await ctx.alertRuleStore.findAll()
      for (const r of Array.isArray(rules) ? rules : []) {
        if (r && typeof r === 'object') severityByRule.set(r.id, r.severity)
      }
    }
  } catch {
    // ignore — we'll fall back to generic colors
  }

  try {
    const raw = (await fetcher()) as RawHistoryEntry[]
    const cutoffMs = Date.now() - sinceMinutes * 60_000
    // Map only state TRANSITIONS to firing — entering 'firing' is the moment
    // worth marking. Resolutions are useful too but noisier; include them as
    // a separate label so the agent can filter if it wants a cleaner overlay.
    const annotations = raw
      .map((e) => {
        const tMs = e.timestamp ? new Date(e.timestamp).getTime() : NaN
        if (!Number.isFinite(tMs) || tMs < cutoffMs) return null
        const ruleName = e.ruleName ?? 'unknown'
        const ruleSeverity = e.ruleId ? severityByRule.get(e.ruleId) : undefined
        const color = ruleSeverity ? SEVERITY_COLOR[ruleSeverity] : SEVERITY_COLOR.medium
        let label: string
        if (e.toState === 'firing') {
          label = `${ruleName} fired`
          if (typeof e.value === 'number' && typeof e.threshold === 'number') {
            label += ` (value=${e.value}, threshold=${e.threshold})`
          }
        } else if (e.toState === 'resolved') {
          label = `${ruleName} resolved`
        } else {
          label = `${ruleName}: ${e.fromState ?? '?'} → ${e.toState ?? '?'}`
        }
        return { time: tMs, label, color }
      })
      .filter((a): a is { time: number; label: string; color: string } => a !== null)
      .sort((a, b) => a.time - b.time)

    const summary = annotations.length === 0
      ? `No alert state changes in the last ${sinceMinutes} minute(s).`
      : `Found ${annotations.length} alert event(s). Pass the JSON below as \`panel.annotations\` on time-axis panels:\n\`\`\`json\n${JSON.stringify(annotations, null, 2)}\n\`\`\``

    ctx.sendEvent({
      type: 'tool_result',
      tool: 'alert_rule.history',
      summary: `${annotations.length} alert events`,
      success: true,
    })
    return summary
  } catch (err) {
    const msg = `Failed to load alert history: ${err instanceof Error ? err.message : String(err)}`
    ctx.sendEvent({ type: 'tool_result', tool: 'alert_rule.history', summary: msg, success: false })
    return msg
  }
}

// ---------------------------------------------------------------------------
// Navigation — open an existing page in the UI
// ---------------------------------------------------------------------------

export async function handleNavigate(
  ctx: ActionContext,
  args: Record<string, unknown>,
): Promise<string> {
  const path = String(args.path ?? '')
  if (!path) return 'Error: "path" is required (e.g., "/dashboards/<id>", "/investigations/<id>", "/alerts").'
  if (!path.startsWith('/')) return 'Error: "path" must start with "/".'

  ctx.sendEvent({
    type: 'tool_call',
    tool: 'navigate',
    args: { path },
    displayText: `Opening ${path}`,
  })
  ctx.setNavigateTo(path)
  const msg = `Navigating to ${path}.`
  ctx.sendEvent({ type: 'tool_result', tool: 'navigate', summary: msg, success: true })
  return msg
}

// ---------------------------------------------------------------------------
// Web search
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Folder lifecycle (minimal — full UI flow lives in /api/folders; agent tools
// cover the create/list cases the orchestrator needs when asked to organize
// dashboards). Permission gate already validated access.
// ---------------------------------------------------------------------------

export async function handleFolderCreate(
  ctx: ActionContext,
  args: Record<string, unknown>,
): Promise<string> {
  if (!ctx.folderRepository) return 'Error: folder backend not configured on this deployment.'
  const title = String(args.title ?? '').trim()
  if (!title) return 'Error: "title" is required.'
  const parentUid = typeof args.parentUid === 'string' && args.parentUid !== '' ? args.parentUid : null

  ctx.sendEvent({ type: 'tool_call', tool: 'folder.create', args: { title, parentUid }, displayText: `Creating folder: ${title}` })

  // Simple uid slug from title; fall back to random if slug collides.
  const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || `folder-${Date.now().toString(36)}`
  let uid = slug
  if (await ctx.folderRepository.findByUid(ctx.identity.orgId, uid)) {
    uid = `${slug}-${Math.random().toString(36).slice(2, 6)}`
  }

  const folder = await ctx.folderRepository.create({
    uid,
    orgId: ctx.identity.orgId,
    title,
    parentUid,
    createdBy: ctx.identity.userId,
    updatedBy: ctx.identity.userId,
  })

  const observation = `Folder "${folder.title}" created (uid=${folder.uid})${folder.parentUid ? ` under ${folder.parentUid}` : ' at root'}.`
  ctx.sendEvent({ type: 'tool_result', tool: 'folder.create', summary: observation, success: true })
  ctx.emitAgentEvent(ctx.makeAgentEvent('agent.tool_completed', { tool: 'folder.create', folderUid: folder.uid }))
  return observation
}

export async function handleFolderList(
  ctx: ActionContext,
  args: Record<string, unknown>,
): Promise<string> {
  if (!ctx.folderRepository) return 'Error: folder backend not configured on this deployment.'
  const parentUid = typeof args.parentUid === 'string' ? args.parentUid : null
  const limit = Math.min(Number(args.limit ?? 50), 200)

  ctx.sendEvent({ type: 'tool_call', tool: 'folder.list', args: { parentUid, limit }, displayText: 'Listing folders' })

  const page = await ctx.folderRepository.list({
    orgId: ctx.identity.orgId,
    parentUid,
    limit,
  })

  // Per-row filter: only return folders the identity can read (see §D12).
  const visible = await ctx.accessControl.filterByPermission(
    ctx.identity,
    page.items,
    (f: GrafanaFolder) => ac.eval('folders:read', `folders:uid:${f.uid}`),
  )

  if (visible.length === 0) {
    const msg = 'No folders visible to you' + (parentUid ? ` under ${parentUid}.` : '.')
    ctx.sendEvent({ type: 'tool_result', tool: 'folder.list', summary: msg, success: true })
    return msg
  }
  const rows = visible
    .slice(0, 20)
    .map((f) => `- ${f.title} (uid=${f.uid})${f.parentUid ? `, parent=${f.parentUid}` : ''}`)
    .join('\n')
  const footer = visible.length > 20 ? `\n... and ${visible.length - 20} more folders` : ''
  const summary = `${visible.length} folders:\n${rows}${footer}`
  ctx.sendEvent({ type: 'tool_result', tool: 'folder.list', summary: `${visible.length} folders`, success: true })
  return summary
}

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
