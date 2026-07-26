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
import {
  createInvestigationWorkingState,
  type HypothesisStatus,
  type InvestigationCheck,
  type InvestigationCheckScope,
  type InvestigationWorkingState,
  normalizeConfidence,
  recordInvestigationCheck,
  type InvestigationCompletionClaim,
  type InvestigationSignalType,
  type ReadFamily,
  readFamilyForTool,
} from '../investigation-state.js';
import { evaluateInvestigationEvidenceGate, explainGateReasons } from '../evidence-gate.js';

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

const DEFAULT_COMPLETION_CONFIDENCE = 0;
const MAX_AUTO_EVIDENCE_CHECKS = 8;

const CITATION_PREFIX_BY_SIGNAL: Partial<Record<InvestigationSignalType, string>> = {
  metric: 'm',
  log: 'l',
  kubernetes: 'k',
  config: 'k',
  change: 'c',
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
      ctx.investigationStates.set(draftId, createInvestigationWorkingState());
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

export async function handleInvestigationRecordCheck(
  ctx: ActionContext,
  args: Record<string, unknown>,
): Promise<string> {
  const investigationId = ctx.activeInvestigationId;
  if (!investigationId) {
    return 'Error: no active investigation. Call investigation_create first.';
  }

  const hypothesis = String(args.hypothesis ?? '').trim();
  const tool = String(args.tool ?? '').trim();
  const result = String(args.result ?? '').trim();
  const interpretation = String(args.interpretation ?? '').trim();
  if (!hypothesis) return 'Error: "hypothesis" is required.';
  if (!tool) return 'Error: "tool" is required.';
  if (!result) return 'Error: "result" is required.';
  if (!interpretation) return 'Error: "interpretation" is required.';

  const signalType = parseSignalType(args.signalType);
  if (!signalType) {
    return 'Error: "signalType" must be one of metric, log, kubernetes, change, trace, config, knowledge, web, other.';
  }
  const status = parseHypothesisStatus(args.status);
  if (!status) {
    return 'Error: "status" must be one of supported, ruled_out, inconclusive.';
  }
  const scope = parseCheckScope(args.scope);
  if (!scope) {
    return 'Error: "scope" must set scope.timeWindow (the time range this check covers) or scope.affected (the objects, namespace, or service it covers).';
  }

  // A check has to be backed by a read that actually happened.
  //
  // Everything above validates shape: the fields are present and the enums are
  // legal. None of it establishes that `tool` ran or that `result` came from
  // anywhere — the agent writes all of it. Without this, the whole evidence
  // gate downstream grades the model's prose rather than its work, and a run
  // that queried nothing could still produce a "verified" root cause by
  // describing checks it never performed.
  //
  // The counters incremented as read tools execute are the ground truth. Each
  // recorded check consumes one real call from its family, so N checks citing
  // metrics need N metric reads to have occurred. This does not prove the
  // stated result matches what came back — that needs the raw output kept and
  // compared, which is worth doing next — but it does close the path where
  // nothing was read at all.
  const backingErr = checkHasBackingRead(ctx, investigationId, tool, signalType, status);
  if (backingErr) return backingErr;

  return withToolEventBoundary(
    ctx.sendEvent,
    'investigation_record_check',
    { investigationId, signalType, status },
    `Recording ${signalType} check`,
    async () => {
      const state = ctx.investigationStates.get(investigationId) ?? createInvestigationWorkingState();
      ctx.investigationStates.set(investigationId, state);
      const check = recordInvestigationCheck(state, {
        hypothesis,
        signalType,
        tool,
        query: typeof args.query === 'string' ? args.query : '',
        result,
        interpretation,
        status,
        scope,
        nextCheck: typeof args.nextCheck === 'string' ? args.nextCheck : undefined,
      });

      return `Recorded ${check.id} (${signalType}, ${status}). Checks: ${state.checks.length}. Supported hypotheses: ${state.hypotheses.filter((h) => h.status === 'supported').length}; ruled out: ${state.hypotheses.filter((h) => h.status === 'ruled_out').length}.`;
    },
  );
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
  const claim = parseCompletionClaim(args);
  if (!claim) {
    return 'Error: investigation_complete requires rootCause.status plus confidence, evidenceRefs, and ruledOut. rootCause.status must be confirmed, likely, or unresolved.';
  }

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
  const investigationStore = ctx.investigationStore;

  let persistedInvestigationId = investigationId;
  if (!pendingCreate) {
    const investigation = await investigationStore.findById!(investigationId);
    if (!investigation) {
      return `Error: investigation "${investigationId}" was not found.`;
    }
    if (investigation.workspaceId !== ctx.identity.orgId) {
      return `Error: investigation "${investigationId}" was not found.`;
    }
  }

  const sections = ctx.investigationSections.get(investigationId) ?? [];

  return withToolEventBoundary(
    ctx.sendEvent,
    'investigation_complete',
    { investigationId },
    `Saving investigation report`,
    async () => {
      if (pendingCreate) {
        const investigation = await investigationStore.create!(
          withWorkspaceScope(ctx.identity, {
            question: pendingCreate.question,
            sessionId: ctx.sessionId,
            userId: 'agent',
          }),
        );
        persistedInvestigationId = investigation.id;
        ctx.completedInvestigationAliases?.set(investigationId, persistedInvestigationId);
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
        const draftState = ctx.investigationStates.get(investigationId);
        if (draftState) {
          ctx.investigationStates.delete(investigationId);
          ctx.investigationStates.set(persistedInvestigationId, draftState);
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

      const state = ctx.investigationStates.get(persistedInvestigationId)
        ?? ctx.investigationStates.get(investigationId);
      const provState = ctx.investigationProvenance.get(persistedInvestigationId);
      // Reopened follow-up with no new checks this session: the working ledger
      // starts empty (historical checks are never persisted in structured
      // form), so re-running the gate would downgrade an already-verified
      // report. Reuse the prior passed gate carried over from the saved
      // report's provenance instead. If new checks were recorded, or the model
      // now claims unresolved, evaluate normally.
      const priorGate = provState?.rootCauseGate;
      const gate = priorGate?.status === 'passed'
        && (state?.checks.length ?? 0) === 0
        && claim.rootCause.status !== 'unresolved'
        ? priorGate
        : evaluateInvestigationEvidenceGate(state, claim);
      const effectiveClaim: InvestigationCompletionClaim = gate.status === 'unresolved' && claim.rootCause.status !== 'unresolved'
        ? {
          ...claim,
          confidence: Math.min(claim.confidence, 0.79),
          rootCause: {
            status: 'unresolved',
            object: claim.rootCause.object,
            field: claim.rootCause.field,
            cause: claim.rootCause.cause,
            nextCheck: `Collect more evidence before declaring a root cause: ${explainGateReasons(gate.reasons).join('; ')}`,
          },
          nextAction: `Collect more evidence before remediation: ${explainGateReasons(gate.reasons).join('; ')}`,
        }
        : claim;

      if (effectiveClaim.rootCause.status === 'unresolved') {
        sections.push({
          type: 'text',
          content: [
            '## Unresolved',
            '',
            `I have a likely explanation but not enough to stand behind a fix. Next check: ${effectiveClaim.rootCause.nextCheck ?? effectiveClaim.nextAction ?? 'not specified'}.`,
            ...(gate.reasons.length
              ? ['', `What is missing: ${explainGateReasons(gate.reasons).join('; ')}.`]
              : []),
          ].join('\n'),
        });
      }

      if (state?.checks.length) {
        appendLedgerSections(sections, state, effectiveClaim, provState);
      }

      // Finalise provenance: copy out a clean Provenance (drop `startedAt`
      // bookkeeping field) and compute end-to-end latency. Cost is left
      // undefined — UI will fall back to "—" or fetch from llm_audit.
      let finalProvenance: (Provenance & { rootCauseGate: ReturnType<typeof evaluateInvestigationEvidenceGate> }) | undefined;
      if (provState) {
        if (provState.citations?.length) {
          provState.evidenceCount = Math.max(
            provState.evidenceCount ?? 0,
            provState.citations.length,
          );
        }
        // Drop bookkeeping-only fields so they never leak into the persisted
        // provenance row.
        const {
          startedAt,
          reportId,
          readToolCalls,
          metricReadCalls,
          logReadCalls,
          opsReadCalls,
          changeReadCalls,
          ...rest
        } = provState;
        void reportId;
        void readToolCalls;
        void metricReadCalls;
        void logReadCalls;
        void opsReadCalls;
        void changeReadCalls;
        const builtProvenance = {
          ...rest,
          rootCauseGate: gate,
          ...(startedAt ? { latencyMs: Date.now() - startedAt } : {}),
        };
        finalProvenance = builtProvenance;
        // Citation-rate warning scaffold (Task 10): we do NOT enforce a
        // threshold yet — that destabilises generation and the roadmap
        // explicitly defers it. Just log when the model produced evidence
        // sections without inline references so we have a metric trail.
        const evCount = builtProvenance.evidenceCount ?? 0;
        const citCount = builtProvenance.citations?.length ?? 0;
        if (evCount > 0 && citCount === 0) {
          log.warn(
            { investigationId: persistedInvestigationId, evidenceCount: evCount, citationCount: citCount },
            'investigation has evidence sections but no inline citations',
          );
        }
      } else {
        finalProvenance = { rootCauseGate: gate };
      }

      // Save the report. When this investigation was reopened, reuse the prior
      // report's id so the store upserts the SAME row in place; otherwise a
      // fresh id inserts a new report.
      // The model wrote `summary` while believing its root cause would stand.
      // When the gate downgrades the claim, saving that text unqualified leaves
      // the report header asserting a cause the body marks unresolved — and the
      // header is what remediation flows read first. Keep the model's findings,
      // but lead with the verdict that actually applies.
      const persistedSummary = effectiveClaim.rootCause.status === 'unresolved'
        && claim.rootCause.status !== 'unresolved'
        ? `Unresolved — the evidence does not verify a root cause. ${summary}`
        : summary;

      await ctx.investigationReportStore.save({
        id: provState?.reportId ?? randomUUID(),
        dashboardId: persistedInvestigationId,
        goal: persistedSummary,
        summary: persistedSummary,
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
      ctx.investigationStates.delete(investigationId);
      ctx.investigationStates.delete(persistedInvestigationId);
      // Clear active id so the next investigation_create starts a fresh one.
      ctx.activeInvestigationId = null;

      // Navigate to the investigation page
      ctx.setNavigateTo(`/investigations/${persistedInvestigationId}`);
      ctx.sendEvent({ type: 'navigate', path: `/investigations/${persistedInvestigationId}` });
      ctx.recordCreatedResource('investigation', persistedInvestigationId);

      if (gate.status === 'unresolved' && claim.rootCause.status !== 'unresolved') {
        return `Investigation saved as unresolved; evidence is insufficient for a verified root cause (${gate.reasons.join('; ')}). Summary: ${summary}`;
      }
      return `Investigation completed and report saved with ${sections.length} sections. Summary: ${summary}`;
    },
  );
}

function appendLedgerSections(
  sections: InvestigationReportSection[],
  state: InvestigationWorkingState,
  claim: InvestigationCompletionClaim,
  provenance?: Provenance,
): void {
  const checks = rankChecksForReport(state, claim);
  if (checks.length === 0) return;

  const citationRefs = assignCitationRefs(checks, provenance);
  const evidenceLines = checks.map((check) => {
    const ref = citationRefs.get(check.id);
    const prefix = ref ? `[${ref}] ` : '';
    const statusLabel = formatStatus(check.status);
    const query = check.query ? ` Query: \`${truncateOneLine(check.query, 180)}\`.` : '';
    return `- ${prefix}**${statusLabel}** ${check.hypothesis}: ${check.result} Interpretation: ${check.interpretation}.${query}`;
  });

  sections.push({
    type: 'text',
    content: [
      '## Evidence Trail',
      '',
      ...evidenceLines,
    ].join('\n'),
  });

  const confidence = Math.round(claim.confidence * 100);
  const rootCause = formatRootCause(claim);
  const ruledOut = claim.ruledOut.length
    ? claim.ruledOut.map((item) => `- ${item}`).join('\n')
    : '- No explicit alternatives were recorded.';
  const nextAction = claim.nextAction ?? claim.rootCause.nextCheck;
  sections.push({
    type: 'text',
    content: [
      '## Conclusion',
      '',
      `Root-cause confidence: **${confidence}%**.`,
      '',
      rootCause,
      '',
      '### Ruled Out',
      '',
      ruledOut,
      ...(nextAction ? ['', '### Next Action', '', nextAction] : []),
    ].join('\n'),
  });
}

function rankChecksForReport(
  state: InvestigationWorkingState,
  claim: InvestigationCompletionClaim,
): InvestigationCheck[] {
  const byId = new Map(state.checks.map((check) => [check.id, check]));
  const selected: InvestigationCheck[] = [];
  for (const id of claim.evidenceRefs) {
    const check = byId.get(id);
    if (check && !selected.some((c) => c.id === check.id)) selected.push(check);
  }
  for (const check of state.checks) {
    if (selected.length >= MAX_AUTO_EVIDENCE_CHECKS) break;
    if (check.status === 'supported' && !selected.some((c) => c.id === check.id)) {
      selected.push(check);
    }
  }
  for (const check of state.checks) {
    if (selected.length >= MAX_AUTO_EVIDENCE_CHECKS) break;
    if (check.status === 'ruled_out' && !selected.some((c) => c.id === check.id)) {
      selected.push(check);
    }
  }
  for (const check of state.checks) {
    if (selected.length >= MAX_AUTO_EVIDENCE_CHECKS) break;
    if (!selected.some((c) => c.id === check.id)) selected.push(check);
  }
  return selected;
}

function assignCitationRefs(
  checks: InvestigationCheck[],
  provenance?: Provenance,
): Map<string, string> {
  const refs = new Map<string, string>();
  if (!provenance) return refs;

  const nextByPrefix: Record<string, number> = { m: 1, l: 1, k: 1, c: 1 };
  for (const citation of provenance.citations ?? []) {
    const match = citation.ref.match(/^([mlkc])(\d+)$/);
    if (!match) continue;
    const prefix = match[1]!;
    nextByPrefix[prefix] = Math.max(nextByPrefix[prefix] ?? 1, Number(match[2]!) + 1);
  }

  const citations = provenance.citations ?? (provenance.citations = []);
  for (const check of checks) {
    const prefix = CITATION_PREFIX_BY_SIGNAL[check.signalType];
    if (!prefix) continue;
    const ref = `${prefix}${nextByPrefix[prefix] ?? 1}`;
    nextByPrefix[prefix] = (nextByPrefix[prefix] ?? 1) + 1;
    refs.set(check.id, ref);
    citations.push({
      ref,
      kind: KIND_BY_PREFIX[prefix]!,
      summary: `${check.tool}: ${truncateOneLine(check.result, 140)}`,
    });
  }
  return refs;
}

function formatStatus(status: HypothesisStatus): string {
  if (status === 'supported') return 'Supported';
  if (status === 'ruled_out') return 'Ruled out';
  return 'Inconclusive';
}

function formatRootCause(claim: InvestigationCompletionClaim): string {
  const root = claim.rootCause;
  if (root.status === 'unresolved') {
    return `Root cause remains unresolved. Next check: ${root.nextCheck ?? claim.nextAction ?? 'not specified'}.`;
  }
  const subject = root.object ?? 'the affected system';
  const field = root.field ? ` (${root.field})` : '';
  const cause = root.cause ?? 'cause not specified';
  return `Root cause: **${subject}${field}** - ${cause}.`;
}

function truncateOneLine(value: string, limit: number): string {
  const oneLine = value.replace(/\s+/g, ' ').trim();
  if (oneLine.length <= limit) return oneLine;
  return `${oneLine.slice(0, Math.max(0, limit - 1))}...`;
}

function parseCompletionClaim(args: Record<string, unknown>): InvestigationCompletionClaim | null {
  const rootRaw = args.rootCause;
  if (!rootRaw || typeof rootRaw !== 'object') return null;
  const root = rootRaw as Record<string, unknown>;
  const status = String(root.status ?? '').trim();
  if (status !== 'confirmed' && status !== 'likely' && status !== 'unresolved') return null;
  const confidence = normalizeConfidence(args.confidence ?? DEFAULT_COMPLETION_CONFIDENCE);
  return {
    rootCause: {
      status,
      object: stringOrUndefined(root.object),
      field: stringOrUndefined(root.field),
      cause: stringOrUndefined(root.cause),
      nextCheck: stringOrUndefined(root.nextCheck),
    },
    confidence,
    evidenceRefs: stringArray(args.evidenceRefs),
    ruledOut: stringArray(args.ruledOut),
    nextAction: stringOrUndefined(args.nextAction),
    validationMethod: stringOrUndefined(args.validationMethod),
  };
}

const READ_FAMILY_LABEL: Readonly<Record<ReadFamily, string>> = {
  metric: 'metrics_* query',
  log: 'logs_* query',
  ops: 'ops_run_command call',
  change: 'changes_list_recent call',
};

function checkHasBackingRead(
  ctx: ActionContext,
  investigationId: string,
  tool: string,
  signalType: InvestigationSignalType,
  status: HypothesisStatus,
): string | null {
  const family = readFamilyForTool(tool, signalType);
  if (!family) return null;

  // Prefer the ledger, which knows whether each source actually answered.
  // Fall back to the counters when no ledger exists (older sessions, and
  // harnesses that drive handlers directly).
  const reads = ctx.investigationReads?.get(investigationId);
  if (reads) {
    const next = reads.find((r) => r.family === family && !r.consumed);
    if (!next) {
      const ran = reads.filter((r) => r.family === family).length;
      return (
        `Error: cannot record this check. It cites a ${READ_FAMILY_LABEL[family]}, and all ${ran} of those `
        + 'this investigation has run are already accounted for by earlier checks. '
        + 'Run the read first, then record what it returned.'
      );
    }
    if (!next.sourceAnswered && status !== 'inconclusive') {
      next.consumed = true;
      return (
        `Error: '${next.action}' could not consult its source, so this hypothesis is inconclusive rather than `
        + `'${status}'. Not being able to look is not the same as having looked and found nothing — record it as `
        + 'inconclusive, say which source is missing, and carry the gap into the report as an open question.'
      );
    }
    next.consumed = true;
    return null;
  }

  const prov = ctx.investigationProvenance.get(investigationId);
  const performed =
    family === 'metric' ? prov?.metricReadCalls ?? 0
    : family === 'log' ? prov?.logReadCalls ?? 0
    : family === 'ops' ? prov?.opsReadCalls ?? 0
    : prov?.changeReadCalls ?? 0;

  const state = ctx.investigationStates.get(investigationId);
  const alreadyRecorded = (state?.checks ?? []).filter(
    (c) => readFamilyForTool(c.tool, c.signalType) === family,
  ).length;

  if (performed > alreadyRecorded) return null;

  return (
    `Error: cannot record this check. It cites a ${READ_FAMILY_LABEL[family]}, but this investigation has run `
    + `${performed} of those and already recorded ${alreadyRecorded} check(s) against them. `
    + 'Run the read first, then record what it returned. Record only what you actually observed.'
  );
}

function parseSignalType(value: unknown): InvestigationSignalType | null {
  const raw = String(value ?? '').trim();
  if (
    raw === 'metric' ||
    raw === 'log' ||
    raw === 'kubernetes' ||
    raw === 'change' ||
    raw === 'trace' ||
    raw === 'config' ||
    raw === 'knowledge' ||
    raw === 'web' ||
    raw === 'other'
  ) {
    return raw;
  }
  return null;
}

/**
 * The evidence gate reads time window / affected scope from these fields
 * instead of pattern-matching the narrative, so a check that carries neither
 * is rejected here rather than silently recorded as unusable evidence.
 */
function parseCheckScope(value: unknown): InvestigationCheckScope | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  const timeWindow = stringOrUndefined(raw.timeWindow);
  const affected = stringOrUndefined(raw.affected);
  if (!timeWindow && !affected) return null;
  return {
    ...(timeWindow ? { timeWindow } : {}),
    ...(affected ? { affected } : {}),
  };
}

function parseHypothesisStatus(value: unknown): HypothesisStatus | null {
  const raw = String(value ?? '').trim();
  if (raw === 'supported' || raw === 'ruled_out' || raw === 'inconclusive') {
    return raw;
  }
  return null;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.map((v) => String(v).trim()).filter(Boolean)
    : [];
}

function stringOrUndefined(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
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
