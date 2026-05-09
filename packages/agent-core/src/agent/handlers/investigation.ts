import { randomUUID } from 'node:crypto';
import { ac } from '@agentic-obs/common';
import { createLogger } from '@agentic-obs/common/logging';
import type {
  Citation,
  InvestigationReportSection,
  PanelConfig,
  PanelVisualization,
  Provenance,
} from '@agentic-obs/common';
import type { ActionContext } from './_context.js';
import { withToolEventBoundary, withWorkspaceScope } from './_shared.js';
import { panelSize } from '../layout-engine.js';

const log = createLogger('investigation-provenance');

/**
 * Match inline evidence citations like `[m1]`, `[l2]`, `[k3]`, `[c1]` —
 * the prefixes encode kind (m=metric, l=log, k=k8s, c=change). Used to
 * count citations in AI-generated section content for the provenance
 * scaffold (Task 10). Roadmap explicitly says NOT to enforce a 95%
 * citation rate yet — we just count and warn.
 */
const CITATION_RX = /\[([mlkc])(\d+)\]/g;
const KIND_BY_PREFIX: Record<string, Citation['kind']> = {
  m: 'metric',
  l: 'log',
  k: 'k8s',
  c: 'change',
};

// ---------------------------------------------------------------------------
// Investigation lifecycle
// ---------------------------------------------------------------------------

export async function handleInvestigationCreate(
  ctx: ActionContext,
  args: Record<string, unknown>,
): Promise<string> {
  if (!ctx.investigationStore) {
    return 'Error: investigation store is not available.';
  }

  const question = String(args.question ?? '');
  if (!question) return 'Error: "question" is required.';

  let createdId = '';
  let observationText = '';
  await withToolEventBoundary(
    ctx.sendEvent,
    'investigation_create',
    { question },
    `Creating investigation: "${question.slice(0, 60)}"`,
    async () => {
      // Same reason as dashboard_create: the GET route filters by
      // workspaceId; missing this field makes the investigation unreachable
      // even though the row is in the store.
      const investigation = await ctx.investigationStore!.create(
        withWorkspaceScope(ctx.identity, {
          question,
          sessionId: ctx.sessionId,
          userId: 'agent',
        }),
      );

      createdId = investigation.id;
      // Mark this investigation as the active one for the session.
      // `add_section` and `complete` read from here; the LLM no longer
      // has to copy the id back through tool params (which it sometimes
      // truncated, silently re-keying sections to a phantom map slot).
      ctx.activeInvestigationId = createdId;
      // Seed the provenance accumulator with model + runId + start time.
      // Cost / latency get filled in at completion (latency from startedAt;
      // cost is left undefined here — the UI joins llm_audit by sessionId
      // when it needs aggregate spend). See ActionContext docs for the
      // full lifecycle.
      ctx.investigationProvenance.set(createdId, {
        model: ctx.model,
        runId: createdId,
        toolCalls: 0,
        evidenceCount: 0,
        citations: [],
        startedAt: Date.now(),
      });
      observationText = `Created investigation "${question.slice(0, 60)}" (id: ${investigation.id}).`;
      return observationText;
    },
  );
  ctx.emitAgentEvent(
    ctx.makeAgentEvent('agent.tool_completed', {
      tool: 'investigation_create',
      investigationId: createdId,
      summary: observationText,
    }),
  );
  return observationText;
}

// ---------------------------------------------------------------------------
// Investigation report section accumulator
//
// Section state lives on `ctx.investigationSections` (one map per session,
// owned by the OrchestratorAgent instance). Previously a module-level `Map`
// in `orchestrator-action-handlers.ts`, which leaked across sessions if two
// concurrent runs reused investigation ids.
// ---------------------------------------------------------------------------

// TODO: migrate to withToolEventBoundary
export async function handleInvestigationAddSection(
  ctx: ActionContext,
  args: Record<string, unknown>,
): Promise<string> {
  const investigationId = ctx.activeInvestigationId;
  if (!investigationId) {
    return 'Error: no active investigation. Call investigation_create first.';
  }

  const rawType = args.type ?? 'text';
  if (rawType !== 'text' && rawType !== 'evidence') {
    return `Error: "type" must be "text" or "evidence" (got ${JSON.stringify(rawType)}).`;
  }
  const sectionType: 'text' | 'evidence' = rawType;
  const content = String(args.content ?? '');
  if (!content) return 'Error: "content" is required.';

  ctx.sendEvent({ type: 'tool_call', tool: 'investigation_add_section', args: { investigationId, type: sectionType }, displayText: `Adding ${sectionType} section to investigation` });

  const section: InvestigationReportSection = { type: sectionType, content };

  // Build panel config and capture snapshot for evidence sections
  if (sectionType === 'evidence' && args.panel && typeof args.panel === 'object') {
    const p = args.panel as Record<string, unknown>;
    const viz = (p.visualization ?? 'time_series') as PanelVisualization;
    const dims = panelSize(viz);
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
    };

    // Capture snapshot data if any metrics adapter is available in the
    // registry. Evidence panels don't carry a sourceId today — pick the
    // first registered metrics datasource (preferring default) so snapshot
    // capture keeps working during the migration. Phase 2 may plumb the
    // sourceId through the panel config.
    const queries = panelConfig.queries ?? [];
    const metricsSources = ctx.adapters.list({ signalType: 'metrics' });
    const chosenSource = metricsSources.find((d) => d.isDefault) ?? metricsSources[0];
    const evidenceAdapter = chosenSource ? ctx.adapters.metrics(chosenSource.id) : undefined;
    if (evidenceAdapter && queries.length > 0) {
      try {
        const hasInstantQuery = queries.some((q) => q.instant);
        if (hasInstantQuery) {
          // Instant snapshot
          const results = await evidenceAdapter.instantQuery(queries[0]!.expr);
          // For stat panels with sparkline=true, also capture a range so the
          // saved investigation renders the trend without needing live data.
          // Failure here is non-fatal — we keep the instant snapshot either way.
          let sparkline: { timestamps: number[]; values: number[] } | undefined;
          if (panelConfig.visualization === 'stat' && panelConfig.sparkline) {
            try {
              const end = new Date();
              const start = new Date(end.getTime() - 60 * 60_000);
              const sparkResults = await evidenceAdapter.rangeQuery(
                queries[0]!.expr,
                start,
                end,
                '60s',
              );
              const first = sparkResults[0];
              if (first && first.values.length > 0) {
                sparkline = {
                  timestamps: first.values.map(([ts]) => ts * 1000),
                  values: first.values.map(([, v]) => Number(v)).filter(Number.isFinite),
                };
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
          };
        } else {
          // Range snapshot
          const end = new Date();
          const start = new Date(end.getTime() - 60 * 60_000); // default 1 hour
          const step = '60s';
          const rangeResults = await Promise.all(
            queries.map(async (q) => {
              const results = await evidenceAdapter.rangeQuery(q.expr, start, end, step);
              return {
                refId: q.refId,
                series: results.map((r) => ({
                  labels: r.metric,
                  points: r.values.map(([ts, val]) => ({ ts, value: Number(val) })),
                })),
                totalSeries: results.length,
              };
            }),
          );
          panelConfig.snapshotData = {
            range: rangeResults,
            capturedAt: new Date().toISOString(),
          };
        }
      } catch {
        // Snapshot capture failed — proceed without snapshot
      }
    }

    section.panel = panelConfig;
  }

  // Accumulate section in the per-session map
  const existing = ctx.investigationSections.get(investigationId) ?? [];
  existing.push(section);
  ctx.investigationSections.set(investigationId, existing);

  // Provenance bookkeeping (Task 10). Each add_section call is one tool
  // call from the agent's perspective; evidence sections also bump the
  // evidence counter. We harvest inline citations into the report-level
  // citation list so the UI can render <CitationChip /> with summaries.
  const prov = ctx.investigationProvenance.get(investigationId);
  if (prov) {
    prov.toolCalls = (prov.toolCalls ?? 0) + 1;
    if (sectionType === 'evidence') {
      prov.evidenceCount = (prov.evidenceCount ?? 0) + 1;
    }
    const sectionIndex = existing.length - 1;
    const list = prov.citations ?? (prov.citations = []);
    for (const m of content.matchAll(CITATION_RX)) {
      const prefix = m[1]!;
      const ref = `${prefix}${m[2]!}`;
      if (list.some((c) => c.ref === ref)) continue;
      list.push({
        ref,
        kind: KIND_BY_PREFIX[prefix]!,
        summary: section.panel?.title ?? content.slice(0, 80),
        sectionIndex,
      });
    }
  }

  const observationText = `Added ${sectionType} section to investigation ${investigationId} (${existing.length} sections total).`;
  ctx.sendEvent({ type: 'tool_result', tool: 'investigation_add_section', summary: observationText, success: true });
  return observationText;
}

export async function handleInvestigationComplete(
  ctx: ActionContext,
  args: Record<string, unknown>,
): Promise<string> {
  const investigationId = ctx.activeInvestigationId;
  if (!investigationId) {
    return 'Error: no active investigation. Call investigation_create first.';
  }
  const summary = String(args.summary ?? '');
  if (!summary) return 'Error: "summary" is required.';

  return withToolEventBoundary(
    ctx.sendEvent,
    'investigation_complete',
    { investigationId },
    `Completing investigation`,
    async () => {
      if (!ctx.investigationStore?.findById) {
        return 'Error: investigation store is not available.';
      }

      const investigation = await ctx.investigationStore.findById(investigationId);
      if (!investigation) {
        return `Error: investigation "${investigationId}" was not found.`;
      }
      if (investigation.workspaceId !== ctx.identity.orgId) {
        return `Error: investigation "${investigationId}" was not found.`;
      }

      const sections = ctx.investigationSections.get(investigationId) ?? [];

      // Finalise provenance: copy out a clean Provenance (drop `startedAt`
      // bookkeeping field) and compute end-to-end latency. Cost is left
      // undefined — UI will fall back to "—" or fetch from llm_audit.
      const provState = ctx.investigationProvenance.get(investigationId);
      let finalProvenance: Provenance | undefined;
      if (provState) {
        const { startedAt, ...rest } = provState;
        finalProvenance = {
          ...rest,
          ...(startedAt ? { latencyMs: Date.now() - startedAt } : {}),
        };
        // Citation-rate warning scaffold (Task 10): we do NOT enforce a
        // threshold yet — that destabilises generation and the roadmap
        // explicitly defers it. Just log when the model produced evidence
        // sections without inline references so we have a metric trail.
        const evCount = finalProvenance.evidenceCount ?? 0;
        const citCount = finalProvenance.citations?.length ?? 0;
        if (evCount > 0 && citCount === 0) {
          log.warn(
            { investigationId, evidenceCount: evCount, citationCount: citCount },
            'investigation has evidence sections but no inline citations',
          );
        }
      }

      // Save the report
      await ctx.investigationReportStore.save({
        id: randomUUID(),
        dashboardId: investigationId,
        goal: summary,
        summary,
        sections,
        createdAt: new Date().toISOString(),
        ...(finalProvenance ? { provenance: finalProvenance } : {}),
      });

      // Update investigation status if store supports it
      if (ctx.investigationStore) {
        try {
          await ctx.investigationStore.updateStatus(investigationId, 'completed');
        } catch {
          // Status update failed — non-fatal
        }
      }

      // Clean up accumulated sections + provenance
      ctx.investigationSections.delete(investigationId);
      ctx.investigationProvenance.delete(investigationId);
      // Clear active id so the next investigation_create starts a fresh one.
      ctx.activeInvestigationId = null;

      // Navigate to the investigation page
      ctx.setNavigateTo(`/investigations/${investigationId}`);

      return `Investigation completed and report saved with ${sections.length} sections. Summary: ${summary}`;
    },
  );
}

// ---------------------------------------------------------------------------
// Investigation list
// ---------------------------------------------------------------------------

function matchesFilter(text: string | undefined, filter: string | undefined): boolean {
  if (!filter) return true;
  if (!text) return false;
  return text.toLowerCase().includes(filter.toLowerCase());
}

// TODO: migrate to withToolEventBoundary
export async function handleInvestigationList(
  ctx: ActionContext,
  args: Record<string, unknown>,
): Promise<string> {
  if (!ctx.investigationStore?.findAll) {
    return 'Error: investigation store does not support listing.';
  }
  const filter = typeof args.filter === 'string' ? args.filter : undefined;
  const limit = typeof args.limit === 'number' ? args.limit : 50;
  ctx.sendEvent({
    type: 'tool_call',
    tool: 'investigation_list',
    args: filter ? { filter } : {},
    displayText: filter ? `Searching investigations matching "${filter}"` : 'Listing investigations',
  });

  try {
    const allRaw = await ctx.investigationStore.findAll();
    const all = await ctx.accessControl.filterByPermission(
      ctx.identity,
      allRaw,
      (inv) => ac.eval(
        'investigations:read',
        `investigations:uid:${inv.id ?? ''}`,
      ),
    );
    const filtered = all.filter((inv) => matchesFilter(inv.intent, filter));
    if (filtered.length === 0) {
      const msg = filter
        ? `No investigations match "${filter}" (${all.length} total).`
        : 'No investigations found.';
      ctx.sendEvent({ type: 'tool_result', tool: 'investigation_list', summary: msg, success: true });
      return msg;
    }
    const lines = filtered.slice(0, limit).map((inv) => {
      const id = inv.id ?? 'unknown';
      const status = inv.status ?? '';
      const intent = inv.intent ?? '(no intent)';
      return `- [${id}]${status ? ` (${status})` : ''} "${intent.slice(0, 100)}"`;
    });
    const summary = `${filtered.length} investigation(s)${filter ? ` matching "${filter}"` : ''}:\n${lines.join('\n')}`;
    ctx.sendEvent({
      type: 'tool_result',
      tool: 'investigation_list',
      summary: `${filtered.length} investigations found`,
      success: true,
    });
    return summary;
  } catch (err) {
    const msg = `Failed to list investigations: ${err instanceof Error ? err.message : String(err)}`;
    ctx.sendEvent({ type: 'tool_result', tool: 'investigation_list', summary: msg, success: false });
    return msg;
  }
}
