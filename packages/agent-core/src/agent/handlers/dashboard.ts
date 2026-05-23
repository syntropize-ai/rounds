import { randomUUID } from 'node:crypto';
import { ac, AuditAction, assertWritable, extractPanelMetricNames, ProvisionedResourceError, querySignature, resolvePanelUnit } from '@agentic-obs/common';
import type { PanelConfig, PanelMetricMetadata, PendingDashboardChange, PendingDashboardChangeOp, DashboardStatus } from '@agentic-obs/common';
import { createLogger } from '@agentic-obs/server-utils/logging';
import type { ActionContext } from './_context.js';
import { withToolEventBoundary, withWorkspaceScope } from './_shared.js';
import { applyLayout } from '../layout-engine.js';
import type { PanelEventType } from '../panel-event-recorder.js';
import {
  isVerifyGateEnabled,
  runDashboardVerifyGate,
  formatVerifyReport,
  logGateOffIssues,
} from './verify-gate.js';

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
  // DEPRECATED — surviving for in-flight frontend agent work. New clients
  // should subscribe to `pending_change_created` (persisted) instead.
  ctx.sendEvent({
    type: 'pending_changes_proposed',
    dashboardId,
    changes: [change],
  });
  return change;
}

/**
 * Persist a first-class pending_changes row when the repo is wired and emit
 * the `pending_change_created` SSE event. Returns the row id (used as the
 * proposal's primary id) so callers can include it in observation text.
 *
 * `panelId` is null for variable/title-level changes.
 *
 * Per Task spec §4: handlers MUST NOT mutate the live dashboard in this path.
 * They write the row, emit the event, and return a "pending user approval"
 * observation. The accept route applies after_json later.
 */
async function persistPendingChange(
  ctx: ActionContext,
  params: {
    dashboardId: string;
    panelId: string | null;
    changeKind: 'modify_panel' | 'add_panel' | 'remove_panel' | 'set_title' | 'add_variable';
    beforeJson: unknown | null;
    afterJson: unknown;
    summary: string;
  },
): Promise<string | null> {
  if (!ctx.pendingChanges) return null;
  const id = randomUUID();
  const proposedAt = new Date().toISOString();
  // 7-day TTL — matches the Task 09 spec; the lifecycle expiry job sweeps
  // stale rows so the in-memory queue can't grow unboundedly.
  const expiresAt = new Date(Date.parse(proposedAt) + 7 * 24 * 60 * 60 * 1000).toISOString();
  try {
    await ctx.pendingChanges.insert({
      id,
      orgId: ctx.identity.orgId,
      dashboardId: params.dashboardId,
      panelId: params.panelId,
      proposedBy: `agent:${ctx.sessionId}`,
      proposedAt,
      changeKind: params.changeKind,
      beforeJson: params.beforeJson,
      afterJson: params.afterJson,
      summary: params.summary,
      expiresAt,
    });
  } catch (err) {
    log.warn(
      {
        dashboardId: params.dashboardId,
        panelId: params.panelId,
        err: err instanceof Error ? err.message : String(err),
      },
      'pending_changes insert failed — falling back to ephemeral SSE',
    );
    return null;
  }
  ctx.sendEvent({
    type: 'pending_change_created',
    id,
    dashboardId: params.dashboardId,
    panelId: params.panelId,
    summary: params.summary,
    changeKind: params.changeKind,
    beforeJson: params.beforeJson,
    afterJson: params.afterJson,
    proposedAt,
  });
  return id;
}

function formatToolError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Coerce a single value to one of the allowed enum members, or undefined.
 * Used in dashboard_add_panels to silently drop hallucinated enum values
 * (e.g. the agent suggests `colorMode: 'auto'`) before they reach the DB
 * and break the read-side zod schema.
 */
function pickEnum<T extends string>(value: unknown, allowed: readonly T[]): T | undefined {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : undefined;
}

/**
 * `pickEnum` but emitted as `{ [key]: value }` so the caller can spread it
 * into an object literal — keeps the field absent when the value is bad,
 * rather than setting it to `undefined`.
 */
function maybeEnum<K extends string, T extends string>(
  key: K,
  value: unknown,
  allowed: readonly T[],
): Partial<Record<K, T>> {
  const picked = pickEnum(value, allowed);
  return picked === undefined ? {} : ({ [key]: picked } as Partial<Record<K, T>>);
}

async function fetchPanelMetadata(
  ctx: ActionContext,
  panel: { title?: unknown; query?: unknown; queries?: unknown },
): Promise<Record<string, PanelMetricMetadata>> {
  const queries = Array.isArray(panel.queries)
    ? panel.queries as Array<Record<string, unknown>>
    : [];
  const unitInput = {
    title: typeof panel.title === 'string' ? panel.title : undefined,
    query: typeof panel.query === 'string' ? panel.query : undefined,
    queries: queries.map((q) => ({ expr: typeof q.expr === 'string' ? q.expr : undefined })),
  };
  const metricNames = extractPanelMetricNames(unitInput);
  if (metricNames.length === 0) return {};

  const byDatasource = new Map<string, Set<string>>();
  for (const q of queries) {
    const datasourceId = typeof q.datasourceId === 'string' ? q.datasourceId.trim() : '';
    if (!datasourceId) continue;
    const qNames = extractPanelMetricNames({ queries: [{ expr: typeof q.expr === 'string' ? q.expr : undefined }] });
    if (qNames.length === 0) continue;
    const set = byDatasource.get(datasourceId) ?? new Set<string>();
    qNames.forEach((name) => set.add(name));
    byDatasource.set(datasourceId, set);
  }

  const metadata: Record<string, PanelMetricMetadata> = {};
  await Promise.all([...byDatasource.entries()].map(async ([datasourceId, names]) => {
    const adapter = ctx.adapters.metrics(datasourceId);
    if (!adapter?.fetchMetadata) return;
    try {
      Object.assign(metadata, await adapter.fetchMetadata([...names]));
    } catch (err) {
      log.debug(
        { datasourceId, err: err instanceof Error ? err.message : String(err) },
        'panel metadata lookup failed',
      );
    }
  }));
  return metadata;
}

async function resolvePanelUnitsForWrite(
  ctx: ActionContext,
  panels: Array<Record<string, unknown>>,
): Promise<Array<Record<string, unknown>>> {
  return Promise.all(panels.map(async (p) => {
    const metadataByMetric = await fetchPanelMetadata(ctx, p);
    const queries = Array.isArray(p.queries)
      ? p.queries.map((q: Record<string, unknown>) => ({ expr: String(q.expr ?? '') }))
      : [];
    const unit = resolvePanelUnit({
      title: String(p.title ?? 'Panel'),
      unit: typeof p.unit === 'string' ? p.unit : undefined,
      queries,
      metadataByMetric,
    });
    if (unit) return { ...p, unit };
    const { unit: _unit, ...withoutUnit } = p;
    return withoutUnit;
  }));
}

/**
 * Fire-and-forget panel-event emission for agent-driven dashboard mutations.
 *
 * The Express dashboard route has its own hook for non-agent CRUD; this
 * mirror exists so agent-only sessions (which bypass POST /api/dashboards)
 * still leave a trail in panel_events. Failures are logged but never
 * surfaced to the caller — panel_events is a behavior-mining sink, never
 * a correctness gate.
 */
function recordPanelEvents(
  ctx: ActionContext,
  dashboardId: string,
  panels: Array<{ id: string; queries?: Array<{ expr?: string }>; query?: string; visualization?: string }>,
  eventType: PanelEventType,
): void {
  const repo = ctx.panelEvents;
  if (!repo) return;
  const orgId = ctx.identity.orgId;
  const actorId = ctx.identity.userId ?? null;
  const sessionId = ctx.sessionId ?? null;
  for (const panel of panels) {
    const firstExpr =
      panel.queries?.[0]?.expr && panel.queries[0].expr.length > 0
        ? panel.queries[0].expr
        : typeof panel.query === 'string' && panel.query.length > 0
          ? panel.query
          : null;
    const sig = firstExpr ? querySignature(firstExpr) : null;
    Promise.resolve()
      .then(() =>
        repo.record({
          orgId,
          dashboardId,
          panelId: panel.id,
          eventType,
          panelSnapshot: panel,
          querySignature: sig && sig.length > 0 ? sig : null,
          vizType: typeof panel.visualization === 'string' ? panel.visualization : null,
          aiGenerated: true,
          actorId,
          sessionId,
        }),
      )
      .catch((err: unknown) => {
        log.warn(
          {
            err: err instanceof Error ? err.message : String(err),
            dashboardId,
            panelId: panel.id,
            eventType,
          },
          'agent panel-event record failed (swallowed)',
        );
      });
  }
}

function emitToolFailure(
  ctx: ActionContext,
  tool: string,
  err: unknown,
): string {
  const msg = formatToolError(err);
  const observationText = `Error: ${msg}`;
  ctx.sendEvent({ type: 'tool_result', tool, summary: observationText });
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

      // Navigate to the new dashboard so the user can see panels being added.
      // Separately record the create relationship — `setNavigateTo` only
      // remembers the latest URL, so multi-create turns (LLM asked for two
      // dashboards in one message) would otherwise leave the non-navigated
      // dashboard without a chat-session linkage and the chat panel would
      // render blank when the user opened it.
      ctx.setNavigateTo(`/dashboards/${dashboard.id}`);
      ctx.recordCreatedResource('dashboard', dashboard.id);

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
      ctx.recordCreatedResource('dashboard', created.id);
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

  const panelsForWrite = await resolvePanelUnitsForWrite(ctx, panels);

  const queries = panelsForWrite
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

  ctx.sendEvent({ type: 'tool_call', tool: 'dashboard_add_panels', args: { count: panelsForWrite.length }, displayText: `Adding ${panelsForWrite.length} panel(s)` });

  // ---- Verify-gate (Wave: AI-first authoring) ---------------------------
  // Runs panel_preview + dashboard_lint server-side on the panel set about
  // to be persisted. ON by default in production; toggle with
  // DASHBOARD_VERIFY_GATE=0. See handlers/verify-gate.ts.
  const verifyReport = await runDashboardVerifyGate(ctx, { panels: panelsForWrite });
  if (!verifyReport.ok) {
    if (isVerifyGateEnabled()) {
      const detail = formatVerifyReport(verifyReport);
      const observation =
        `Error: dashboard_add_panels rejected by verify-gate. Fix the following before retrying:\n${detail}`;
      ctx.sendEvent({ type: 'tool_result', tool: 'dashboard_add_panels', summary: observation });
      return observation;
    }
    // Gate OFF: log + accept. We still surface the issues to operators via
    // a structured WARN log so production telemetry catches the regressions.
    logGateOffIssues(verifyReport);
  }

  try {
    // Pre-existing dashboards: route each new panel through pendingChanges
    // so the user accepts before it appears. Freshly-created dashboards in
    // this session apply directly (the bulk-add UX during creation would
    // otherwise stall until the user clicked accept on every panel).
    //
    // The pendingChanges-wired check preserves backward-compat for callers
    // that don't run the persisted-proposal pipeline (legacy tests, pure
    // in-memory deployments). When the repo isn't wired add_panels keeps
    // its pre-Task-AI-1 apply-directly behavior.
    if (ctx.pendingChanges && !isFreshlyCreated(ctx, dashboardId)) {
      const proposalIds: string[] = [];
      for (const p of panelsForWrite) {
        const summary = `Add panel "${String(p.title ?? 'Panel')}"`;
        const rowId = await persistPendingChange(ctx, {
          dashboardId,
          panelId: null,
          changeKind: 'add_panel',
          beforeJson: null,
          afterJson: p,
          summary,
        });
        if (rowId) proposalIds.push(rowId);
      }
      const observationText = proposalIds.length > 0
        ? `Proposed ${proposalIds.length} new panel(s) (${proposalIds.join(', ')}). Pending user approval.`
        : `Proposed ${panelsForWrite.length} new panel(s); pending user review.`;
      ctx.sendEvent({ type: 'tool_result', tool: 'dashboard_add_panels', summary: observationText });
      return observationText;
    }
    return await runAddPanels(ctx, dashboardId, panelsForWrite);
  } catch (err) {
    // Critical: a throw partway through panel generation would otherwise
    // leave the dashboard stuck at 'generating' forever (the list badge
    // turns yellow and never resolves). Flip to 'failed' with the error
    // message so the UI can render an actionable state, then rethrow so
    // the orchestrator's outer error handling still runs.
    const msg = err instanceof Error ? err.message : String(err);
    await tryUpdateDashboardStatus(ctx, dashboardId, 'failed', msg);
    ctx.sendEvent({ type: 'tool_result', tool: 'dashboard_add_panels', summary: msg });
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
    unit: resolvePanelUnit({
      title: String(p.title ?? 'Panel'),
      unit: typeof p.unit === 'string' ? p.unit : undefined,
      queries: Array.isArray(p.queries)
        ? p.queries.map((q: Record<string, unknown>) => ({ expr: String(q.expr ?? '') }))
        : [],
    }),
    stackMode: pickEnum(p.stackMode, ['none', 'normal', 'percent'] as const),
    fillOpacity: typeof p.fillOpacity === 'number' ? p.fillOpacity : undefined,
    decimals: typeof p.decimals === 'number' ? p.decimals : undefined,
    thresholds: Array.isArray(p.thresholds)
      ? (p.thresholds as Array<Record<string, unknown>>)
          .filter((t) => typeof t.value === 'number' && typeof t.color === 'string')
          .map((t) => ({
            value: t.value as number,
            color: t.color as string,
            ...(typeof t.label === 'string' ? { label: t.label } : {}),
          })) as import('@agentic-obs/common').PanelThreshold[]
      : undefined,
    // Visual polish hints from agent. Enums are filtered against the
    // canonical allow-list so a hallucinated value ('avg' for legendStats,
    // 'auto' for colorMode, etc.) is silently dropped instead of corrupting
    // the dashboard JSON — the row stays loadable, the LLM's intent is
    // ignored.
    ...(typeof p.sparkline === 'boolean' ? { sparkline: p.sparkline } : {}),
    ...maybeEnum('colorMode', p.colorMode, ['value', 'background', 'none'] as const),
    ...maybeEnum('graphMode', p.graphMode, ['none', 'area'] as const),
    ...(typeof p.lineWidth === 'number' ? { lineWidth: p.lineWidth } : {}),
    ...(Array.isArray(p.legendStats)
      ? { legendStats: (p.legendStats as unknown[]).filter((v): v is 'last' | 'mean' | 'max' | 'min' =>
          v === 'last' || v === 'mean' || v === 'max' || v === 'min') }
      : {}),
    ...maybeEnum('legendPlacement', p.legendPlacement, ['bottom', 'right'] as const),
    ...maybeEnum('colorScale', p.colorScale, ['linear', 'sqrt', 'log'] as const),
    ...maybeEnum('showPoints', p.showPoints, ['auto', 'never'] as const),
    ...maybeEnum('yScale', p.yScale, ['linear', 'log'] as const),
    ...(typeof p.collapseEmptyBuckets === 'boolean' ? { collapseEmptyBuckets: p.collapseEmptyBuckets } : {}),
    ...(typeof p.barGaugeMax === 'number' ? { barGaugeMax: p.barGaugeMax } : {}),
    ...maybeEnum('barGaugeMode', p.barGaugeMode, ['gradient', 'lcd'] as const),
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

  // Fire panel_events rows for the freshly-added panels. The Express route
  // does not see this path (agent CRUD bypasses POST /api/dashboards), so
  // without this hook agent-only sessions leave panel_events empty.
  recordPanelEvents(ctx, dashboardId, panelConfigs, 'created');

  const observationText = `Added ${panelConfigs.length} panel(s): ${panelConfigs.map((p) => p.title).join(', ')}`;
  ctx.sendEvent({ type: 'tool_result', tool: 'dashboard_add_panels', summary: observationText });
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
      // Pre-existing dashboards route through pendingChanges so the user
      // accepts the rename before it lands; freshly-created dashboards in
      // this session apply directly (same pattern as the other mutations).
      // Gated on pendingChanges being wired to preserve apply-directly
      // semantics for in-memory deployments and legacy tests.
      if (ctx.pendingChanges && !isFreshlyCreated(ctx, dashboardId)) {
        let before: { title: string; description: string } | null = null;
        try {
          if (ctx.store.findById) {
            const dash = await ctx.store.findById(dashboardId);
            if (dash) before = { title: dash.title, description: dash.description };
          }
        } catch {
          before = null;
        }
        const after = {
          title,
          description: description ?? before?.description ?? '',
        };
        const summary = `Rename dashboard to "${title}"`;
        const rowId = await persistPendingChange(ctx, {
          dashboardId,
          panelId: null,
          changeKind: 'set_title',
          beforeJson: before,
          afterJson: after,
          summary,
        });
        if (rowId === null) {
          await queuePending(
            ctx,
            dashboardId,
            // `set_title` isn't part of the legacy PendingDashboardChangeOp
            // union; fall back to a direct apply when pendingChanges isn't
            // wired (preserves pre-Task-AI-1 behavior for in-memory tests).
            { kind: 'modify_panel', panelId: '', patch: {} } as PendingDashboardChangeOp,
            summary,
          ).catch(() => {/* legacy queue may not support set_title; ignore */});
          await ctx.actionExecutor.execute(dashboardId, [{ type: 'set_title', title, ...(description !== undefined ? { description } : {}) }]);
          return `Title set to "${title}".`;
        }
        return `Proposed change ${rowId}: ${summary}. Pending user approval.`;
      }
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
      // Capture each removal target snapshot for the row's before_json so the
      // diff UI can render "what will be removed".
      const byId: Map<string, PanelConfig> = new Map();
      try {
        if (ctx.store.findById) {
          const dash = await ctx.store.findById(dashboardId);
          if (dash) for (const p of dash.panels) byId.set(p.id, p);
        }
      } catch {
        // best-effort; missing snapshots become null in before_json
      }
      const proposalIds: string[] = [];
      for (const panelId of panelIds) {
        const before = byId.get(panelId) ?? null;
        const summary = `Remove panel ${before?.title ?? panelId}`;
        const rowId = await persistPendingChange(ctx, {
          dashboardId,
          panelId,
          changeKind: 'remove_panel',
          beforeJson: before,
          // remove_panel after_json = null sentinel: row reduces to "drop this id"
          afterJson: { panelId },
          summary,
        });
        if (rowId === null) {
          await queuePending(
            ctx,
            dashboardId,
            { kind: 'remove_panel', panelId },
            `Remove panel ${panelId}`,
          );
        } else {
          proposalIds.push(rowId);
        }
      }
      const observationText = proposalIds.length > 0
        ? `Proposed removal of ${proposalIds.length} panel(s) (${proposalIds.join(', ')}). Pending user approval.`
        : `Proposed removal of ${panelIds.length} panel(s); pending user review.`;
      ctx.sendEvent({ type: 'tool_result', tool: 'dashboard_remove_panels', summary: observationText });
      return observationText;
    }

    // Capture the panel snapshots before deletion so the panel_events row
    // carries the spec at delete-time (the row outlives the dashboard panel).
    const removedSnapshots = await (async (): Promise<PanelConfig[]> => {
      try {
        const dash = ctx.store.findById ? await ctx.store.findById(dashboardId) : null;
        if (!dash) return panelIds.map((id) => ({ id } as PanelConfig));
        const byId = new Map(dash.panels.map((p) => [p.id, p]));
        return panelIds.map((id) => byId.get(id) ?? ({ id } as PanelConfig));
      } catch {
        return panelIds.map((id) => ({ id } as PanelConfig));
      }
    })();

    await ctx.actionExecutor.execute(dashboardId, [{ type: 'remove_panels', panelIds }]);

    recordPanelEvents(ctx, dashboardId, removedSnapshots, 'deleted');

    const observationText = `Removed ${panelIds.length} panel(s).`;
    ctx.sendEvent({ type: 'tool_result', tool: 'dashboard_remove_panels', summary: observationText });
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

  if (typeof patch.unit === 'string' || Array.isArray(patch.queries)) {
    let beforePanel: PanelConfig | null = null;
    try {
      if (ctx.store.findById) {
        const dash = await ctx.store.findById(dashboardId);
        beforePanel = dash?.panels.find((p) => p.id === panelId) ?? null;
      }
    } catch {
      beforePanel = null;
    }
    const title = typeof patch.title === 'string' ? patch.title : beforePanel?.title;
    const queriesRaw = Array.isArray(patch.queries) ? patch.queries : beforePanel?.queries ?? [];
    const metadataByMetric = await fetchPanelMetadata(ctx, { title, queries: queriesRaw });
    const unit = resolvePanelUnit({
      title,
      unit: typeof patch.unit === 'string' ? patch.unit : beforePanel?.unit,
      queries: Array.isArray(queriesRaw)
        ? queriesRaw.map((q: Record<string, unknown>) => ({ expr: String(q.expr ?? '') }))
        : [],
      metadataByMetric,
    });
    if (unit) patch.unit = unit;
    else delete patch.unit;
  }

  ctx.sendEvent({ type: 'tool_call', tool: 'dashboard_modify_panel', args: { panelId, patch }, displayText: `Modifying panel ${panelId}` });

  try {
    // Task 09 — modifying a panel on a pre-existing dashboard goes to
    // pendingChanges (the dashboard may be shared; the user must accept).
    if (!isFreshlyCreated(ctx, dashboardId)) {
      // First-class persisted proposal (T-AI-1) when the repo is wired.
      // Capture a before-snapshot for the diff UI, compute after = before+patch.
      let beforePanel: PanelConfig | null = null;
      try {
        if (ctx.store.findById) {
          const dash = await ctx.store.findById(dashboardId);
          beforePanel = dash?.panels.find((p) => p.id === panelId) ?? null;
        }
      } catch {
        beforePanel = null;
      }
      const afterPanel = beforePanel
        ? ({ ...beforePanel, ...(patch as object) } as PanelConfig)
        : ({ id: panelId, ...(patch as object) } as PanelConfig);
      const summary = `Modify panel ${beforePanel?.title ?? panelId}`;
      const rowId = await persistPendingChange(ctx, {
        dashboardId,
        panelId,
        changeKind: 'modify_panel',
        beforeJson: beforePanel,
        afterJson: afterPanel,
        summary,
      });
      if (rowId === null) {
        // Repo missing or insert failed — keep the legacy ephemeral path so
        // the in-flight frontend agent's work still sees a proposal.
        await queuePending(
          ctx,
          dashboardId,
          { kind: 'modify_panel', panelId, patch },
          `Modify panel ${panelId}`,
        );
      }
      const observationText = rowId
        ? `Proposed change ${rowId}: ${summary}. Pending user approval.`
        : `Proposed modification of panel ${panelId}; pending user review.`;
      ctx.sendEvent({ type: 'tool_result', tool: 'dashboard_modify_panel', summary: observationText });
      return observationText;
    }

    await ctx.actionExecutor.execute(dashboardId, [{ type: 'modify_panel', panelId, patch }]);

    // Look up the post-patch panel for a faithful snapshot in panel_events.
    // Fallback to a thin {id, ...patch} when findById is unavailable.
    let snapshot: PanelConfig = { id: panelId, ...(patch as object) } as PanelConfig;
    try {
      if (ctx.store.findById) {
        const dash = await ctx.store.findById(dashboardId);
        const found = dash?.panels.find((p) => p.id === panelId);
        if (found) snapshot = found;
      }
    } catch {
      // best-effort; keep the patch-derived snapshot
    }
    recordPanelEvents(ctx, dashboardId, [snapshot], 'edited');

    const observationText = `Modified panel ${panelId}.`;
    ctx.sendEvent({ type: 'tool_result', tool: 'dashboard_modify_panel', summary: observationText });
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
      const summary = `Add variable $${variable.name}`;
      const rowId = await persistPendingChange(ctx, {
        dashboardId,
        panelId: null,
        changeKind: 'add_variable',
        beforeJson: null,
        afterJson: variable,
        summary,
      });
      if (rowId === null) {
        await queuePending(
          ctx,
          dashboardId,
          { kind: 'add_variable', variable },
          summary,
        );
      }
      const observationText = rowId
        ? `Proposed change ${rowId}: ${summary}. Pending user approval.`
        : `Proposed variable $${variable.name}; pending user review.`;
      ctx.sendEvent({ type: 'tool_result', tool: 'dashboard_add_variable', summary: observationText });
      return observationText;
    }

    await ctx.actionExecutor.execute(dashboardId, [{ type: 'add_variable', variable }]);

    const observationText = `Added variable $${variable.name}.`;
    ctx.sendEvent({ type: 'tool_result', tool: 'dashboard_add_variable', summary: observationText });
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
      ctx.sendEvent({ type: 'tool_result', tool: 'dashboard_list', summary: msg });
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
    });
    return summary;
  } catch (err) {
    const msg = `Failed to list dashboards: ${err instanceof Error ? err.message : String(err)}`;
    ctx.sendEvent({ type: 'tool_result', tool: 'dashboard_list', summary: msg });
    return msg;
  }
}
