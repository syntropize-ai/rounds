import { randomUUID } from 'node:crypto';
import { ac, AuditAction } from '@agentic-obs/common';
import { createLogger } from '@agentic-obs/server-utils/logging';
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

/**
 * Bounds the audit↔resume loop: a `NEEDS_MORE` verdict bounces the investigator
 * back to keep digging, but only this many times. On exhaustion the report
 * ships with an `## Unresolved` caveat (honest-flagged beats blocked-forever).
 */
const MAX_AUDIT_ROUNDS = 2;

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

  let draftId = '';
  let observationText = '';
  await withToolEventBoundary(
    ctx.sendEvent,
    'investigation_create',
    { question },
    `Preparing investigation: "${question.slice(0, 60)}"`,
    async () => {
      draftId = `draft_investigation_${randomUUID()}`;
      ctx.pendingInvestigationCreates.set(draftId, { question });
      // Mark this investigation as the active one for the session.
      // `add_section` and `complete` read from here; the LLM no longer
      // has to copy the id back through tool params (which it sometimes
      // truncated, silently re-keying sections to a phantom map slot).
      ctx.activeInvestigationId = draftId;
      // Seed the provenance accumulator with model + runId + start time.
      // Cost / latency get filled in at completion (latency from startedAt;
      // cost is left undefined here — the UI joins llm_audit by sessionId
      // when it needs aggregate spend). See ActionContext docs for the
      // full lifecycle.
      ctx.investigationProvenance.set(draftId, {
        model: ctx.model,
        runId: draftId,
        toolCalls: 0,
        evidenceCount: 0,
        citations: [],
        startedAt: Date.now(),
      });
      observationText = `Prepared investigation "${question.slice(0, 60)}" (draft id: ${draftId}). It will be created when the report is complete.`;
      return observationText;
    },
  );
  ctx.emitAgentEvent(
    ctx.makeAgentEvent('agent.tool_completed', {
      tool: 'investigation_create',
      investigationId: draftId,
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

/**
 * Add a narrative (markdown) section to the active investigation.
 * Single-purpose wrapper — strictly text, no panel. Replaces the old
 * `investigation_add_section(type='text', ...)` shape so the model can't
 * accidentally pick text when the situation warranted evidence.
 */
export async function handleInvestigationAddText(
  ctx: ActionContext,
  args: Record<string, unknown>,
): Promise<string> {
  return handleInvestigationAddSection(ctx, { ...args, type: 'text' });
}

/**
 * Add a chart-backed evidence section. `panel` is structurally required —
 * if you don't have a query to attach yet, run `metrics_range_query` first
 * and use its `expr` as `panel.queries[0].expr`. The system captures the
 * snapshot automatically.
 */
export async function handleInvestigationAddEvidence(
  ctx: ActionContext,
  args: Record<string, unknown>,
): Promise<string> {
  return handleInvestigationAddSection(ctx, { ...args, type: 'evidence' });
}

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

  return withToolEventBoundary(
    ctx.sendEvent,
    'investigation_add_section',
    { investigationId, type: sectionType },
    `Adding ${sectionType} section to investigation`,
    async () => {
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
        // first registered metrics connector (preferring default) so snapshot
        // capture keeps working during the migration. Phase 2 may plumb the
        // sourceId through the panel config.
        const queries = panelConfig.queries ?? [];
        const metricsSources = ctx.adapters.list({ signalType: 'metrics' });
        const chosenSource = metricsSources.find((d) => d.isDefault) ?? metricsSources[0];
        const evidenceAdapter = chosenSource ? ctx.adapters.metrics(chosenSource.id) : undefined;
        if (evidenceAdapter && queries.length > 0) {
          const adapterId = chosenSource?.id ?? 'unknown';
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
                } catch (sparkErr) {
                  // Non-fatal: instant snapshot still wins. Operators get a trail
                  // so missing sparklines are explicable rather than mysterious.
                  log.warn(
                    {
                      investigationId,
                      panelTitle: panelConfig.title,
                      queryKind: 'sparkline',
                      adapterId,
                      errorClass: sparkErr instanceof Error ? sparkErr.constructor.name : typeof sparkErr,
                      error: sparkErr instanceof Error ? sparkErr.message : String(sparkErr),
                    },
                    'investigation sparkline capture failed',
                  );
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
          } catch (capErr) {
            // Snapshot capture failed — investigation still completes (the
            // evidence is optional polish, not the report itself). Log so
            // operators can correlate empty evidence panels with adapter
            // failures, and stamp a `captureError` provenance marker on the
            // panel so the UI can render "(capture failed)" instead of an
            // empty chart.
            const queryKind = queries.some((q) => q.instant) ? 'instant' : 'range';
            const errMsg = capErr instanceof Error ? capErr.message : String(capErr);
            log.warn(
              {
                investigationId,
                panelTitle: panelConfig.title,
                queryKind,
                adapterId,
                errorClass: capErr instanceof Error ? capErr.constructor.name : typeof capErr,
                error: errMsg,
              },
              'investigation snapshot capture failed',
            );
            panelConfig.snapshotData = {
              capturedAt: new Date().toISOString(),
              captureError: errMsg,
            };
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

      return `Added ${sectionType} section to investigation ${investigationId} (${existing.length} sections total).`;
    },
  );
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
      if (!ctx.investigationStore) {
        return 'Error: investigation store is not available.';
      }

      const pendingCreate = ctx.pendingInvestigationCreates.get(investigationId);
      if (pendingCreate && !ctx.investigationStore.create) {
        return 'Error: investigation store is not available.';
      }
      if (!pendingCreate && !ctx.investigationStore.findById) {
        return 'Error: investigation store is not available.';
      }
      let persistedInvestigationId = investigationId;
      let question = pendingCreate?.question ?? '';
      if (!pendingCreate) {
        const investigation = await ctx.investigationStore.findById!(investigationId);
        if (!investigation) {
          return `Error: investigation "${investigationId}" was not found.`;
        }
        if (investigation.workspaceId !== ctx.identity.orgId) {
          return `Error: investigation "${investigationId}" was not found.`;
        }
        question = investigation.intent;
      }

      const sections = ctx.investigationSections.get(investigationId) ?? [];

      // --- Independent audit gate ---
      // Before persisting, an independent read-only auditor judges whether the
      // user could fix the problem from this report ALONE. NEEDS_MORE bounces
      // the investigator back to keep digging (the loop resumes — see below).
      // Skipped (fail-open) when `runAuditor` is unwired (tests) or provenance
      // is absent.
      const provForAudit = ctx.investigationProvenance.get(investigationId);
      let unresolvedGap: string | null = null;
      if (ctx.runAuditor && provForAudit) {
        const reportText = [summary, ...sections.map((s) => s.content)].join('\n\n');
        const { verdict, gap } = await ctx.runAuditor({ question, report: reportText });
        if (verdict === 'NEEDS_MORE') {
          const rounds = provForAudit.auditorRounds ?? 0;
          if (rounds < MAX_AUDIT_ROUNDS) {
            provForAudit.auditorRounds = rounds + 1;
            log.warn({ investigationId, round: rounds + 1 }, 'investigation_complete sent back by auditor');
            // Returning a guidance string WITHOUT persisting or clearing the
            // active id is the resume: the ReActLoop feeds this back as the
            // next observation and the investigator re-completes when ready.
            return `Investigation NOT completed - an independent auditor judged the report not yet directly actionable. ${gap} `
              + 'Keep going: close that gap so the user could fix the problem from the report alone, then call investigation_complete again.';
          }
          unresolvedGap = gap; // budget exhausted -> ship, flagged
          log.warn({ investigationId }, 'auditor budget exhausted; completing with unresolved caveat');
        }
      }

      if (pendingCreate) {
        const investigation = await ctx.investigationStore.create(
          withWorkspaceScope(ctx.identity, {
            question: pendingCreate.question,
            sessionId: ctx.sessionId,
            userId: 'agent',
          }),
        );
        persistedInvestigationId = investigation.id;
        ctx.pendingInvestigationCreates.delete(investigationId);
        ctx.activeInvestigationId = persistedInvestigationId;
        ctx.investigationSections.delete(investigationId);
        ctx.investigationSections.set(persistedInvestigationId, sections);
        const draftProvenance = ctx.investigationProvenance.get(investigationId);
        if (draftProvenance) {
          ctx.investigationProvenance.delete(investigationId);
          ctx.investigationProvenance.set(persistedInvestigationId, {
            ...draftProvenance,
            runId: persistedInvestigationId,
          });
        }
        void ctx.auditWriter?.({
          action: AuditAction.InvestigationCreate,
          actorType: 'user',
          actorId: ctx.identity.userId,
          orgId: ctx.identity.orgId,
          targetType: 'investigation',
          targetId: investigation.id,
          targetName: pendingCreate.question,
          outcome: 'success',
          metadata: { sessionId: ctx.sessionId, via: 'agent_tool' },
        });
      }

      if (unresolvedGap) {
        sections.push({
          type: 'text',
          content: `## Unresolved\n\nCompleted with a gap an independent auditor flagged: ${unresolvedGap}. Treat the conclusion as provisional until this is addressed.`,
        });
      }

      // Finalise provenance: copy out a clean Provenance (drop `startedAt`
      // bookkeeping field) and compute end-to-end latency. Cost is left
      // undefined — UI will fall back to "—" or fetch from llm_audit.
      const provState = ctx.investigationProvenance.get(persistedInvestigationId);
      let finalProvenance: Provenance | undefined;
      if (provState) {
        // Drop bookkeeping-only fields (`startedAt`, `auditorRounds`,
        // `reportId`) so they never leak into the persisted provenance row.
        const { startedAt, auditorRounds, reportId, ...rest } = provState;
        void auditorRounds;
        void reportId;
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
            { investigationId: persistedInvestigationId, evidenceCount: evCount, citationCount: citCount },
            'investigation has evidence sections but no inline citations',
          );
        }
      }

      // Save the report. When this investigation was reopened, reuse the prior
      // report's id so the store upserts the SAME row in place; otherwise a
      // fresh id inserts a new report.
      await ctx.investigationReportStore.save({
        id: provState?.reportId ?? randomUUID(),
        dashboardId: persistedInvestigationId,
        goal: summary,
        summary,
        sections,
        createdAt: new Date().toISOString(),
        ...(finalProvenance ? { provenance: finalProvenance } : {}),
      });

      // Update investigation status if store supports it. Non-fatal: the
      // report is already saved, so callers shouldn't see a hard error
      // just because the status row is briefly stale. Log loudly so the
      // mismatch is discoverable instead of silent.
      if (ctx.investigationStore) {
        try {
          await ctx.investigationStore.updateStatus(persistedInvestigationId, 'completed');
        } catch (err) {
          log.warn(
            {
              investigationId: persistedInvestigationId,
              targetStatus: 'completed',
              errorClass: err instanceof Error ? err.constructor.name : typeof err,
              error: err instanceof Error ? err.message : String(err),
            },
            'investigation updateStatus failed; report saved but status stale',
          );
        }
      }

      // Clean up accumulated sections + provenance
      ctx.investigationSections.delete(investigationId);
      ctx.investigationSections.delete(persistedInvestigationId);
      ctx.investigationProvenance.delete(investigationId);
      ctx.investigationProvenance.delete(persistedInvestigationId);
      // Clear active id so the next investigation_create starts a fresh one.
      ctx.activeInvestigationId = null;

      // Navigate to the investigation page
      ctx.setNavigateTo(`/investigations/${persistedInvestigationId}`);
      ctx.sendEvent({ type: 'navigate', path: `/investigations/${persistedInvestigationId}` });
      ctx.recordCreatedResource('investigation', persistedInvestigationId);

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
      ctx.sendEvent({ type: 'tool_result', tool: 'investigation_list', summary: msg });
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
    });
    return summary;
  } catch (err) {
    const msg = `Failed to list investigations: ${err instanceof Error ? err.message : String(err)}`;
    ctx.sendEvent({ type: 'tool_result', tool: 'investigation_list', summary: msg });
    return msg;
  }
}
