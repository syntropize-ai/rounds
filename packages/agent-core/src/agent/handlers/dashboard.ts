import { randomUUID } from 'node:crypto';
import { ac, AuditAction, assertWritable, ProvisionedResourceError } from '@agentic-obs/common';
import type { PendingDashboardChange, PendingDashboardChangeOp, DashboardStatus } from '@agentic-obs/common';
import { createLogger } from '@agentic-obs/server-utils/logging';
import type { ActionContext } from './_context.js';
import { withToolEventBoundary, withWorkspaceScope } from './_shared.js';
import { applyLayout } from '../layout-engine.js';

const log = createLogger('dashboard-handler');

/**
 * Best-effort `updateStatus` write. On failure we log a structured warning
 * AND emit an SSE `error` event so the web UI doesn't sit on a stale
 * 'generating' badge silently. We still don't fail the caller — the
 * dashboard itself is fine; only the status row is out of sync.
 */
async function tryUpdateDashboardStatus(
  ctx: ActionContext,
  dashboardId: string,
  status: DashboardStatus,
  errorMessage?: string,
): Promise<void> {
  if (!ctx.store.updateStatus) return;
  try {
    await ctx.store.updateStatus(dashboardId, status, errorMessage);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn(
      {
        dashboardId,
        targetStatus: status,
        errorClass: err instanceof Error ? err.constructor.name : typeof err,
        error: msg,
      },
      'dashboard updateStatus failed',
    );
    ctx.sendEvent({
      type: 'error',
      message: `Failed to update dashboard status to "${status}": ${msg}`,
    });
  }
}

// ---------------------------------------------------------------------------
// Pending-changes helper — Task 09
//
// Mutations targeting a dashboard the agent did NOT create in this session
// are queued for user review instead of being applied directly. This protects
// shared dashboards from silent AI overwrites. The agent_executor (Task 06's
// RiskAwareConfirm) handles risky background-agent flows; this surface is the
// dashboard-workspace equivalent for low-risk user-conversation edits.
// ---------------------------------------------------------------------------

function isFreshlyCreated(ctx: ActionContext, dashboardId: string): boolean {
  return ctx.freshlyCreatedDashboards.has(dashboardId);
}

async function queuePending(
  ctx: ActionContext,
  dashboardId: string,
  op: PendingDashboardChangeOp,
  summary: string,
): Promise<PendingDashboardChange> {
  const change: PendingDashboardChange = {
    id: randomUUID(),
    proposedAt: new Date().toISOString(),
    proposedBy: 'agent',
    sessionId: ctx.sessionId,
    summary,
    op,
  };
  if (ctx.store.appendPendingChanges) {
    await ctx.store.appendPendingChanges(dashboardId, [change]);
  }
  // SSE event so the chat panel can show pending changes inline.
  ctx.sendEvent({
    type: 'pending_changes_proposed',
    dashboardId,
    changes: [change],
  });
  return change;
}

function formatToolError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function emitToolFailure(
  ctx: ActionContext,
  tool: string,
  err: unknown,
): string {
  const msg = formatToolError(err);
  const observationText = `Error: ${msg}`;
  ctx.sendEvent({ type: 'tool_result', tool, summary: observationText, success: false });
  return observationText;
}

// ---------------------------------------------------------------------------
// Dashboard lifecycle
// ---------------------------------------------------------------------------

export async function handleDashboardCreate(
  ctx: ActionContext,
  args: Record<string, unknown>,
): Promise<string> {
  if (!ctx.store.create) {
    return 'Error: dashboard store does not support creation.';
  }

  const title = String(args.title ?? 'Untitled Dashboard');
  const description = String(args.description ?? '');
  const prompt = String(args.prompt ?? args.description ?? '');
  const datasourceId = typeof args.datasourceId === 'string' ? args.datasourceId.trim() : '';
  if (!datasourceId) {
    return 'Error: "datasourceId" is required. Call connectors_list (or connectors_suggest) first to choose the primary connector for this dashboard.';
  }

  let createdId = '';
  let observationText = '';
  await withToolEventBoundary(
    ctx.sendEvent,
    'dashboard_create',
    { title, datasourceId },
    `Creating dashboard: "${title}"`,
    async () => {
      // Scope the new dashboard to the caller's org; the detail route enforces
      // workspaceId equality, so missing this field makes the redirect land on
      // "Dashboard not found" even though the row is in the store.
      const dashboard = await ctx.store.create!(
        withWorkspaceScope(ctx.identity, {
          title,
          description,
          prompt,
          userId: 'agent',
          // Stored as an array (dashboards may bind multiple sources for cross-
          // env comparison panels); the first id is the dashboard's primary
          // and acts as the fallback for any query that omits its own ds id.
          datasourceIds: [datasourceId],
          sessionId: ctx.sessionId,
          // Agent-tool created — see writable-gate.ts for source taxonomy.
          source: 'ai_generated',
        }),
      );

      // Navigate to the new dashboard so the user can see panels being added
      ctx.setNavigateTo(`/dashboards/${dashboard.id}`);

      createdId = dashboard.id;
      void ctx.auditWriter?.({
        action: AuditAction.DashboardCreate,
        actorType: 'user',
        actorId: ctx.identity.userId,
        orgId: ctx.identity.orgId,
        targetType: 'dashboard',
        targetId: dashboard.id,
        targetName: dashboard.title,
        outcome: 'success',
        metadata: { datasourceId, via: 'agent_tool' },
      });
      // Mark this dashboard as the active one for the session — subsequent
      // dashboard_add_panels / modify_panel / etc. calls in this ReAct loop
      // pick it up implicitly instead of taking a (truncatable) id param.
      ctx.activeDashboardId = createdId;
      // Task 09 — initial population (add_panels, etc.) on a freshly-created
      // dashboard applies directly; only mutations to pre-existing dashboards
      // funnel through pendingChanges.
      ctx.freshlyCreatedDashboards.add(createdId);
      observationText = `Created dashboard "${dashboard.title}" (id: ${dashboard.id}).`;
      return observationText;
    },
  );
  ctx.emitAgentEvent(
    ctx.makeAgentEvent('agent.tool_completed', {
      tool: 'dashboard_create',
      dashboardId: createdId,
      summary: observationText,
    }),
  );
  return observationText;
}

// ---------------------------------------------------------------------------
// Dashboard clone — duplicate a dashboard onto a different datasource
// ---------------------------------------------------------------------------

export async function handleDashboardClone(
  ctx: ActionContext,
  args: Record<string, unknown>,
): Promise<string> {
  const sourceDashboardId = String(args.sourceDashboardId ?? '');
  if (!sourceDashboardId) return 'Error: "sourceDashboardId" is required.';
  const targetDatasourceId = String(args.targetDatasourceId ?? '');
  if (!targetDatasourceId) return 'Error: "targetDatasourceId" is required.';

  if (!ctx.store.create) {
    return 'Error: dashboard store does not support creation.';
  }
  if (!ctx.store.findById) {
    return 'Error: dashboard store does not support findById.';
  }

  return withToolEventBoundary(
    ctx.sendEvent,
    'dashboard_clone',
    { sourceDashboardId, targetDatasourceId },
    `Cloning dashboard ${sourceDashboardId} → ${targetDatasourceId}`,
    async () => {
      const source = await ctx.store.findById(sourceDashboardId);
      if (!source) {
        return `Error: source dashboard ${sourceDashboardId} not found.`;
      }

      const newTitle =
        typeof args.newTitle === 'string' && args.newTitle.trim()
          ? args.newTitle.trim()
          : `${source.title} (cloned)`;

      // Deep-clone panels and rewrite every query's datasourceId. New panel
      // ids are assigned so the clone has a fresh identity (otherwise panel
      // mutations on the new dashboard could collide with the source's ids
      // through any id-keyed cache).
      type CommonPanel = import('@agentic-obs/common').PanelConfig;
      const clonedPanels: CommonPanel[] = source.panels.map((p) => ({
        ...p,
        id: randomUUID(),
        queries: (p.queries ?? []).map((q) => ({
          ...q,
          datasourceId: targetDatasourceId,
        })),
      }));

      const created = await ctx.store.create!(
        withWorkspaceScope(ctx.identity, {
          title: newTitle,
          description: source.description,
          prompt: source.prompt,
          userId: 'agent',
          datasourceIds: [targetDatasourceId],
          sessionId: ctx.sessionId,
          // Agent-tool clone — treat as AI-generated.
          source: 'ai_generated',
        }),
      );

      // Persist panels + variables onto the freshly created shell. Variables
      // copy over verbatim — they carry no per-connector state on their own.
      await ctx.store.updatePanels(created.id, clonedPanels);
      await ctx.store.updateVariables(created.id, source.variables ?? []);
      await tryUpdateDashboardStatus(ctx, created.id, 'ready');

      ctx.setNavigateTo(`/dashboards/${created.id}`);
      // The freshly cloned dashboard becomes the active one (same as create).
      ctx.activeDashboardId = created.id;
      ctx.freshlyCreatedDashboards.add(created.id);

      void ctx.auditWriter?.({
        action: AuditAction.DashboardFork,
        actorType: 'user',
        actorId: ctx.identity.userId,
        orgId: ctx.identity.orgId,
        targetType: 'dashboard',
        targetId: created.id,
        targetName: created.title,
        outcome: 'success',
        metadata: { sourceDashboardId, targetDatasourceId, via: 'agent_tool' },
      });

      const observation = `Cloned "${source.title}" (${clonedPanels.length} panel${clonedPanels.length === 1 ? '' : 's'}) to connector ${targetDatasourceId}. New dashboard id: ${created.id}.`;
      ctx.emitAgentEvent(
        ctx.makeAgentEvent('agent.tool_completed', {
          tool: 'dashboard_clone',
          sourceDashboardId,
          newDashboardId: created.id,
          targetDatasourceId,
          panelCount: clonedPanels.length,
          summary: observation,
        }),
      );
      return observation;
    },
  );
}

// ---------------------------------------------------------------------------
// Dashboard mutation primitives — model constructs panel configs directly
// ---------------------------------------------------------------------------

// TODO: migrate to withToolEventBoundary
export async function handleDashboardAddPanels(
  ctx: ActionContext,
  args: Record<string, unknown>,
): Promise<string> {
  const dashboardId = ctx.activeDashboardId;
  if (!dashboardId) {
    return 'Error: no active dashboard. Call dashboard_create first.';
  }
  const panels = args.panels as Array<Record<string, unknown>> | undefined;
  if (!panels || !Array.isArray(panels) || panels.length === 0) {
    return 'Error: "panels" array is required with at least one panel config.';
  }

  // Strict per-query datasourceId contract: every query on every panel must
  // carry an explicit datasourceId before we'll persist. No silent inheritance,
  // no fallback to the dashboard primary, no resolver guessing — if the agent
  // forgot, we error out and tell it which query was incomplete so the next
  // tool turn fixes it. Saved panels are guaranteed self-describing; the
  // renderer never sees `datasourceId: undefined`.
  const missing: string[] = [];
  panels.forEach((p, i) => {
    const qs = Array.isArray(p.queries) ? p.queries as Array<Record<string, unknown>> : [];
    qs.forEach((q, j) => {
      const ds = typeof q.datasourceId === 'string' ? q.datasourceId.trim() : '';
      if (!ds) missing.push(`panels[${i}].queries[${j}] (refId=${q.refId ?? '?'})`);
    });
  });
  if (missing.length > 0) {
    return `Error: every query needs a datasourceId. Missing on: ${missing.join(', ')}. Pass datasourceId per query — the dashboard primary is NOT inherited automatically. For a single-source dashboard, set every query to the dashboard's primary; for compare panels, set per query.`;
  }

  const queries = panels
    .flatMap((p) => Array.isArray(p.queries) ? p.queries as Array<Record<string, unknown>> : [])
    .map((q) => String(q.expr ?? '').trim())
    .filter((expr) => expr.length > 0);
  if (queries.length > 0) {
    const evidence = ctx.dashboardBuildEvidence;
    if (evidence.webSearchCount === 0 && evidence.metricDiscoveryCount === 0) {
      return 'Error: dashboard_add_panels requires prior metric research. Call web_search for named-system/exporter dashboards or metrics_discover for existing metrics before adding panels.';
    }
    const unvalidated = [...new Set(queries)].filter((expr) => !evidence.validatedQueries.has(expr));
    if (unvalidated.length > 0) {
      return `Error: validate panel queries before dashboard_add_panels. Call metrics_validate for: ${unvalidated.join(' | ')}`;
    }
  }

  ctx.sendEvent({ type: 'tool_call', tool: 'dashboard_add_panels', args: { count: panels.length }, displayText: `Adding ${panels.length} panel(s)` });

  try {
    return await runAddPanels(ctx, dashboardId, panels);
  } catch (err) {
    // Critical: a throw partway through panel generation would otherwise
    // leave the dashboard stuck at 'generating' forever (the list badge
    // turns yellow and never resolves). Flip to 'failed' with the error
    // message so the UI can render an actionable state, then rethrow so
    // the orchestrator's tool_result(success: false) path still runs.
    const msg = err instanceof Error ? err.message : String(err);
    await tryUpdateDashboardStatus(ctx, dashboardId, 'failed', msg);
    ctx.sendEvent({ type: 'tool_result', tool: 'dashboard_add_panels', summary: msg, success: false });
    throw err;
  }
}

async function runAddPanels(
  ctx: ActionContext,
  dashboardId: string,
  panels: Array<Record<string, unknown>>,
): Promise<string> {
  type CommonPanel = import('@agentic-obs/common').PanelConfig;
  // Panel sizing is NOT the agent's concern — every panel gets a viz-based
  // default from the layout-engine's panelSize(); users can drag to resize
  // in the UI afterward. Any width/height the agent emits is deliberately
  // ignored so proportions stay consistent across dashboards.
  const rawPanels: CommonPanel[] = panels.map((p) => {
    const viz = (p.visualization ?? 'time_series') as import('@agentic-obs/common').PanelVisualization;
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
      // Already validated above — every query carries a non-empty datasourceId.
      datasourceId: (q.datasourceId as string).trim(),
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
  });
  });

  // Apply auto-layout, then offset below existing panels
  const laidOut = applyLayout(rawPanels);
  const existing = await ctx.store.findById(dashboardId);
  const startRow = existing
    ? Math.max(0, ...existing.panels.map((p) => p.row + p.height))
    : 0;
  const panelConfigs = laidOut.map((p) => ({ ...p, row: p.row + startRow }));

  await ctx.actionExecutor.execute(dashboardId, [{ type: 'add_panels', panels: panelConfigs }]);

  // Flip the dashboard out of its initial 'generating' state once it has
  // real panels — the list page shows a yellow "GENERATING" badge until
  // status becomes 'ready', which looked wrong for a dashboard the user
  // can already open and see populated. tryUpdateDashboardStatus logs +
  // emits an SSE error if the status write itself fails.
  await tryUpdateDashboardStatus(ctx, dashboardId, 'ready');

  const observationText = `Added ${panelConfigs.length} panel(s): ${panelConfigs.map((p) => p.title).join(', ')}`;
  ctx.sendEvent({ type: 'tool_result', tool: 'dashboard_add_panels', summary: observationText, success: true });
  // Stream each new panel as a discrete `panel_added` event so the live
  // dashboard view (useDashboardChat) can splice it into the rendered grid
  // without a page refresh. Without these the chat hook only sees
  // `tool_result` and the user has to F5 to see the new panels.
  for (const panel of panelConfigs) {
    ctx.sendEvent({ type: 'panel_added', panel } as never);
  }
  ctx.emitAgentEvent(ctx.makeAgentEvent('agent.tool_completed', { tool: 'dashboard_add_panels', summary: observationText }));
  return observationText;
}

export async function handleDashboardSetTitle(
  ctx: ActionContext,
  args: Record<string, unknown>,
): Promise<string> {
  const dashboardId = ctx.activeDashboardId;
  if (!dashboardId) {
    return 'Error: no active dashboard. Call dashboard_create first.';
  }
  const title = String(args.title ?? '');
  const description = typeof args.description === 'string' ? args.description : undefined;
  if (!title) return 'Error: "title" is required.';

  return withToolEventBoundary(
    ctx.sendEvent,
    'dashboard_set_title',
    { title },
    `Setting title: "${title}"`,
    async () => {
      await ctx.actionExecutor.execute(dashboardId, [{ type: 'set_title', title, ...(description !== undefined ? { description } : {}) }]);
      return `Title set to "${title}".`;
    },
  );
}

// TODO: migrate to withToolEventBoundary
export async function handleDashboardRemovePanels(
  ctx: ActionContext,
  args: Record<string, unknown>,
): Promise<string> {
  const dashboardId = ctx.activeDashboardId;
  if (!dashboardId) {
    return 'Error: no active dashboard. Call dashboard_create first.';
  }
  const panelIds = Array.isArray(args.panelIds) ? args.panelIds.map(String) : [];
  if (panelIds.length === 0) return 'Error: "panelIds" array is required.';

  ctx.sendEvent({ type: 'tool_call', tool: 'dashboard_remove_panels', args: { panelIds }, displayText: `Removing ${panelIds.length} panel(s)` });

  try {
    // Task 09 — removing panels on a pre-existing (shared) dashboard goes to
    // pendingChanges so the user reviews each removal before the dashboard is
    // mutated. Freshly-created dashboards in this session apply directly.
    if (!isFreshlyCreated(ctx, dashboardId)) {
      for (const panelId of panelIds) {
        await queuePending(
          ctx,
          dashboardId,
          { kind: 'remove_panel', panelId },
          `Remove panel ${panelId}`,
        );
      }
      const observationText = `Proposed removal of ${panelIds.length} panel(s); pending user review.`;
      ctx.sendEvent({ type: 'tool_result', tool: 'dashboard_remove_panels', summary: observationText, success: true });
      return observationText;
    }

    await ctx.actionExecutor.execute(dashboardId, [{ type: 'remove_panels', panelIds }]);

    const observationText = `Removed ${panelIds.length} panel(s).`;
    ctx.sendEvent({ type: 'tool_result', tool: 'dashboard_remove_panels', summary: observationText, success: true });
    // Stream `panel_removed` per id so the live view drops them without F5.
    for (const panelId of panelIds) {
      ctx.sendEvent({ type: 'panel_removed', panelId } as never);
    }
    return observationText;
  } catch (err) {
    return emitToolFailure(ctx, 'dashboard_remove_panels', err);
  }
}

// TODO: migrate to withToolEventBoundary
export async function handleDashboardModifyPanel(
  ctx: ActionContext,
  args: Record<string, unknown>,
): Promise<string> {
  const dashboardId = ctx.activeDashboardId;
  if (!dashboardId) {
    return 'Error: no active dashboard. Call dashboard_create first.';
  }
  const panelId = String(args.panelId ?? '');
  if (!panelId) return 'Error: "panelId" is required.';
  const patch = { ...args } as Record<string, unknown>;
  delete patch.panelId;

  // If the patch replaces the queries list, every replacement query must
  // carry datasourceId — same strict contract as add_panels. Patches that
  // don't touch queries pass through untouched.
  if (Array.isArray(patch.queries)) {
    const missing: string[] = [];
    (patch.queries as Array<Record<string, unknown>>).forEach((q, j) => {
      const ds = typeof q.datasourceId === 'string' ? q.datasourceId.trim() : '';
      if (!ds) missing.push(`queries[${j}] (refId=${q.refId ?? '?'})`);
    });
    if (missing.length > 0) {
      return `Error: every query needs a datasourceId. Missing on: ${missing.join(', ')}. Pass datasourceId per query — not inherited.`;
    }
  }

  ctx.sendEvent({ type: 'tool_call', tool: 'dashboard_modify_panel', args: { panelId, patch }, displayText: `Modifying panel ${panelId}` });

  try {
    // Task 09 — modifying a panel on a pre-existing dashboard goes to
    // pendingChanges (the dashboard may be shared; the user must accept).
    if (!isFreshlyCreated(ctx, dashboardId)) {
      await queuePending(
        ctx,
        dashboardId,
        { kind: 'modify_panel', panelId, patch },
        `Modify panel ${panelId}`,
      );
      const observationText = `Proposed modification of panel ${panelId}; pending user review.`;
      ctx.sendEvent({ type: 'tool_result', tool: 'dashboard_modify_panel', summary: observationText, success: true });
      return observationText;
    }

    await ctx.actionExecutor.execute(dashboardId, [{ type: 'modify_panel', panelId, patch }]);

    const observationText = `Modified panel ${panelId}.`;
    ctx.sendEvent({ type: 'tool_result', tool: 'dashboard_modify_panel', summary: observationText, success: true });
    // Stream `panel_modified` so the live view applies the patch without F5.
    ctx.sendEvent({ type: 'panel_modified', panelId, patch } as never);
    return observationText;
  } catch (err) {
    return emitToolFailure(ctx, 'dashboard_modify_panel', err);
  }
}

// TODO: migrate to withToolEventBoundary
export async function handleDashboardAddVariable(
  ctx: ActionContext,
  args: Record<string, unknown>,
): Promise<string> {
  const dashboardId = ctx.activeDashboardId;
  if (!dashboardId) {
    return 'Error: no active dashboard. Call dashboard_create first.';
  }
  const variable = args.variable as import('@agentic-obs/common').DashboardVariable ?? {
    name: String(args.name ?? ''),
    label: String(args.label ?? args.name ?? ''),
    type: (args.type ?? 'query') as 'query' | 'custom' | 'datasource',
    query: typeof args.query === 'string' ? args.query : undefined,
    multi: args.multi === true,
    includeAll: args.includeAll === true,
  };
  if (!variable.name) return 'Error: variable "name" is required.';

  ctx.sendEvent({ type: 'tool_call', tool: 'dashboard_add_variable', args: { name: variable.name }, displayText: `Adding variable: $${variable.name}` });

  try {
    // Task 09 — variable changes on a pre-existing dashboard route through
    // pendingChanges. Variables affect every panel's query, so silently mutating
    // a shared dashboard's variable set would be especially disruptive.
    if (!isFreshlyCreated(ctx, dashboardId)) {
      await queuePending(
        ctx,
        dashboardId,
        { kind: 'add_variable', variable },
        `Add variable $${variable.name}`,
      );
      const observationText = `Proposed variable $${variable.name}; pending user review.`;
      ctx.sendEvent({ type: 'tool_result', tool: 'dashboard_add_variable', summary: observationText, success: true });
      return observationText;
    }

    await ctx.actionExecutor.execute(dashboardId, [{ type: 'add_variable', variable }]);

    const observationText = `Added variable $${variable.name}.`;
    ctx.sendEvent({ type: 'tool_result', tool: 'dashboard_add_variable', summary: observationText, success: true });
    return observationText;
  } catch (err) {
    return emitToolFailure(ctx, 'dashboard_add_variable', err);
  }
}

// ---------------------------------------------------------------------------
// Dashboard list/search
// ---------------------------------------------------------------------------

function matchesFilter(text: string | undefined, filter: string | undefined): boolean {
  if (!filter) return true;
  if (!text) return false;
  return text.toLowerCase().includes(filter.toLowerCase());
}

// TODO: migrate to withToolEventBoundary
export async function handleDashboardList(
  ctx: ActionContext,
  args: Record<string, unknown>,
): Promise<string> {
  if (!ctx.store.findAll) {
    return 'Error: dashboard store does not support listing.';
  }
  const filter = typeof args.filter === 'string' ? args.filter : undefined;
  const limit = typeof args.limit === 'number' ? args.limit : 50;
  ctx.sendEvent({
    type: 'tool_call',
    tool: 'dashboard_list',
    args: filter ? { filter } : {},
    displayText: filter ? `Searching dashboards matching "${filter}"` : 'Listing dashboards',
  });

  try {
    const allRaw = await ctx.store.findAll();
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
    );
    const filtered = all.filter((d) => matchesFilter(d.title, filter) || matchesFilter(d.description, filter));
    if (filtered.length === 0) {
      const msg = filter
        ? `No dashboards match "${filter}" (${all.length} total).`
        : 'No dashboards found.';
      ctx.sendEvent({ type: 'tool_result', tool: 'dashboard_list', summary: msg, success: true });
      return msg;
    }
    const lines = filtered.slice(0, limit).map((d) => {
      const id = (d as unknown as { id?: string }).id ?? 'unknown';
      const desc = d.description ? ` — ${d.description.slice(0, 80)}` : '';
      return `- [${id}] "${d.title}"${desc}`;
    });
    const summary = `${filtered.length} dashboard(s)${filter ? ` matching "${filter}"` : ''}:\n${lines.join('\n')}`;
    ctx.sendEvent({
      type: 'tool_result',
      tool: 'dashboard_list',
      summary: `${filtered.length} dashboards found`,
      success: true,
    });
    return summary;
  } catch (err) {
    const msg = `Failed to list dashboards: ${err instanceof Error ? err.message : String(err)}`;
    ctx.sendEvent({ type: 'tool_result', tool: 'dashboard_list', summary: msg, success: false });
    return msg;
  }
}
