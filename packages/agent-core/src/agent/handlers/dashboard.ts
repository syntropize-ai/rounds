import { randomUUID } from 'node:crypto';
import { ac } from '@agentic-obs/common';
import type { ActionContext } from './_context.js';
import { withToolEventBoundary, withWorkspaceScope } from './_shared.js';
import { applyLayout } from '../layout-engine.js';

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

  let createdId = '';
  let observationText = '';
  await withToolEventBoundary(
    ctx.sendEvent,
    'dashboard.create',
    { title },
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
          datasourceIds: [],
          sessionId: ctx.sessionId,
        }),
      );

      // Navigate to the new dashboard so the user can see panels being added
      ctx.setNavigateTo(`/dashboards/${dashboard.id}`);

      createdId = dashboard.id;
      observationText = `Created dashboard "${dashboard.title}" (id: ${dashboard.id}).`;
      return observationText;
    },
  );
  ctx.emitAgentEvent(
    ctx.makeAgentEvent('agent.tool_completed', {
      tool: 'dashboard.create',
      dashboardId: createdId,
      summary: observationText,
    }),
  );
  return observationText;
}

// ---------------------------------------------------------------------------
// Dashboard mutation primitives — model constructs panel configs directly
// ---------------------------------------------------------------------------

// TODO: migrate to withToolEventBoundary
export async function handleDashboardAddPanels(
  ctx: ActionContext,
  args: Record<string, unknown>,
): Promise<string> {
  const dashboardId = String(args.dashboardId ?? '');
  if (!dashboardId) return 'Error: "dashboardId" is required.';
  const panels = args.panels as Array<Record<string, unknown>> | undefined;
  if (!panels || !Array.isArray(panels) || panels.length === 0) {
    return 'Error: "panels" array is required with at least one panel config.';
  }

  ctx.sendEvent({ type: 'tool_call', tool: 'dashboard.add_panels', args: { count: panels.length }, displayText: `Adding ${panels.length} panel(s)` });

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
  // can already open and see populated. Best-effort; older store shapes
  // may not implement updateStatus.
  if (ctx.store.updateStatus) {
    try {
      await ctx.store.updateStatus(dashboardId, 'ready');
    } catch {
      /* non-fatal — badge will stay 'generating' until next status write */
    }
  }

  const observationText = `Added ${panelConfigs.length} panel(s): ${panelConfigs.map((p) => p.title).join(', ')}`;
  ctx.sendEvent({ type: 'tool_result', tool: 'dashboard.add_panels', summary: observationText, success: true });
  // Stream each new panel as a discrete `panel_added` event so the live
  // dashboard view (useDashboardChat) can splice it into the rendered grid
  // without a page refresh. Without these the chat hook only sees
  // `tool_result` and the user has to F5 to see the new panels.
  for (const panel of panelConfigs) {
    ctx.sendEvent({ type: 'panel_added', panel } as never);
  }
  ctx.emitAgentEvent(ctx.makeAgentEvent('agent.tool_completed', { tool: 'dashboard.add_panels', summary: observationText }));
  return observationText;
}

export async function handleDashboardSetTitle(
  ctx: ActionContext,
  args: Record<string, unknown>,
): Promise<string> {
  const dashboardId = String(args.dashboardId ?? '');
  if (!dashboardId) return 'Error: "dashboardId" is required.';
  const title = String(args.title ?? '');
  const description = typeof args.description === 'string' ? args.description : undefined;
  if (!title) return 'Error: "title" is required.';

  return withToolEventBoundary(
    ctx.sendEvent,
    'dashboard.set_title',
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
  const dashboardId = String(args.dashboardId ?? '');
  if (!dashboardId) return 'Error: "dashboardId" is required.';
  const panelIds = Array.isArray(args.panelIds) ? args.panelIds.map(String) : [];
  if (panelIds.length === 0) return 'Error: "panelIds" array is required.';

  ctx.sendEvent({ type: 'tool_call', tool: 'dashboard.remove_panels', args: { panelIds }, displayText: `Removing ${panelIds.length} panel(s)` });
  await ctx.actionExecutor.execute(dashboardId, [{ type: 'remove_panels', panelIds }]);

  const observationText = `Removed ${panelIds.length} panel(s).`;
  ctx.sendEvent({ type: 'tool_result', tool: 'dashboard.remove_panels', summary: observationText, success: true });
  // Stream `panel_removed` per id so the live view drops them without F5.
  for (const panelId of panelIds) {
    ctx.sendEvent({ type: 'panel_removed', panelId } as never);
  }
  return observationText;
}

// TODO: migrate to withToolEventBoundary
export async function handleDashboardModifyPanel(
  ctx: ActionContext,
  args: Record<string, unknown>,
): Promise<string> {
  const dashboardId = String(args.dashboardId ?? '');
  if (!dashboardId) return 'Error: "dashboardId" is required.';
  const panelId = String(args.panelId ?? '');
  if (!panelId) return 'Error: "panelId" is required.';
  const patch = { ...args } as Record<string, unknown>;
  delete patch.panelId;

  ctx.sendEvent({ type: 'tool_call', tool: 'dashboard.modify_panel', args: { panelId, patch }, displayText: `Modifying panel ${panelId}` });
  await ctx.actionExecutor.execute(dashboardId, [{ type: 'modify_panel', panelId, patch }]);

  const observationText = `Modified panel ${panelId}.`;
  ctx.sendEvent({ type: 'tool_result', tool: 'dashboard.modify_panel', summary: observationText, success: true });
  // Stream `panel_modified` so the live view applies the patch without F5.
  ctx.sendEvent({ type: 'panel_modified', panelId, patch } as never);
  return observationText;
}

// TODO: migrate to withToolEventBoundary
export async function handleDashboardAddVariable(
  ctx: ActionContext,
  args: Record<string, unknown>,
): Promise<string> {
  const dashboardId = String(args.dashboardId ?? '');
  if (!dashboardId) return 'Error: "dashboardId" is required.';
  const variable = args.variable as import('@agentic-obs/common').DashboardVariable ?? {
    name: String(args.name ?? ''),
    label: String(args.label ?? args.name ?? ''),
    type: (args.type ?? 'query') as 'query' | 'custom' | 'datasource',
    query: typeof args.query === 'string' ? args.query : undefined,
    multi: args.multi === true,
    includeAll: args.includeAll === true,
  };
  if (!variable.name) return 'Error: variable "name" is required.';

  ctx.sendEvent({ type: 'tool_call', tool: 'dashboard.add_variable', args: { name: variable.name }, displayText: `Adding variable: $${variable.name}` });
  await ctx.actionExecutor.execute(dashboardId, [{ type: 'add_variable', variable }]);

  const observationText = `Added variable $${variable.name}.`;
  ctx.sendEvent({ type: 'tool_result', tool: 'dashboard.add_variable', summary: observationText, success: true });
  return observationText;
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
    tool: 'dashboard.list',
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
      ctx.sendEvent({ type: 'tool_result', tool: 'dashboard.list', summary: msg, success: true });
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
      tool: 'dashboard.list',
      summary: `${filtered.length} dashboards found`,
      success: true,
    });
    return summary;
  } catch (err) {
    const msg = `Failed to list dashboards: ${err instanceof Error ? err.message : String(err)}`;
    ctx.sendEvent({ type: 'tool_result', tool: 'dashboard.list', summary: msg, success: false });
    return msg;
  }
}
