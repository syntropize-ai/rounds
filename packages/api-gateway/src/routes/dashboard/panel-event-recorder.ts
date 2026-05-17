/**
 * Panel-event recorder — translates dashboard CRUD outcomes into rows in the
 * `panel_events` table. Every public method is fire-and-forget: the caller
 * MUST NOT await this in the response hot path. Failures are swallowed and
 * logged so the originating mutation still returns 200.
 *
 * The recorder is intentionally thin — it does not own the lint analysis
 * (offline jobs do), only the collection pipeline.
 */

import { createLogger } from '@agentic-obs/server-utils/logging';
import { querySignature } from '@agentic-obs/common';
import type { Dashboard, PanelConfig } from '@agentic-obs/common';
import type { IPanelEventRepository, PanelEventType } from '@agentic-obs/data-layer';

const log = createLogger('panel-event-recorder');

export interface RecorderContext {
  orgId: string;
  actorId: string | null;
  sessionId: string | null;
  /** Dashboard-level flag → inherited to every panel event in this batch. */
  aiGenerated: boolean;
  dashboardId: string;
}

export interface PanelEventRecorder {
  recordCreated(ctx: RecorderContext, panels: PanelConfig[]): void;
  recordEdited(ctx: RecorderContext, panels: PanelConfig[]): void;
  recordDeleted(ctx: RecorderContext, panels: PanelConfig[]): void;
  recordCloned(ctx: RecorderContext, panels: PanelConfig[]): void;
  recordViewed(ctx: RecorderContext, panels: PanelConfig[]): void;
  /**
   * Diff old vs new panel lists and emit created/edited/deleted accordingly.
   * Used by PUT /dashboards/:id when the body replaces the full panel list.
   */
  recordPanelDiff(ctx: RecorderContext, before: PanelConfig[], after: PanelConfig[]): void;
}

function firstExpr(panel: PanelConfig): string | null {
  if (panel.queries && panel.queries.length > 0) {
    const expr = panel.queries[0]!.expr;
    if (typeof expr === 'string' && expr.length > 0) return expr;
  }
  if (typeof panel.query === 'string' && panel.query.length > 0) return panel.query;
  return null;
}

function sigFor(panel: PanelConfig): string | null {
  const expr = firstExpr(panel);
  if (!expr) return null;
  const sig = querySignature(expr);
  return sig.length === 0 ? null : sig;
}

function vizFor(panel: PanelConfig): string | null {
  return typeof panel.visualization === 'string' ? panel.visualization : null;
}

export function isAiGenerated(dashboard: Pick<Dashboard, 'source'> | undefined): boolean {
  return dashboard?.source === 'ai_generated';
}

/**
 * Shallow JSON-equality on the persisted fields we care about. We don't have
 * structural diffing here — the offline job can re-derive intent from the
 * snapshot pair. Returning `true` means "no panel-level change", which lets
 * `recordPanelDiff` skip the 'edited' event entirely.
 */
function panelEqual(a: PanelConfig, b: PanelConfig): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export function createPanelEventRecorder(repo: IPanelEventRepository): PanelEventRecorder {
  function emit(ctx: RecorderContext, panel: PanelConfig, type: PanelEventType): void {
    // Fire-and-forget. .catch() is essential — `record()` returns a Promise
    // and an uncaught rejection here would crash the process under
    // `--unhandled-rejections=strict`.
    Promise.resolve()
      .then(() =>
        repo.record({
          orgId: ctx.orgId,
          dashboardId: ctx.dashboardId,
          panelId: panel.id,
          eventType: type,
          panelSnapshot: panel,
          querySignature: sigFor(panel),
          vizType: vizFor(panel),
          aiGenerated: ctx.aiGenerated,
          actorId: ctx.actorId,
          sessionId: ctx.sessionId,
        }),
      )
      .catch((err: unknown) => {
        log.error(
          {
            err: err instanceof Error ? err.message : String(err),
            dashboardId: ctx.dashboardId,
            panelId: panel.id,
            eventType: type,
          },
          'panel-event record failed (swallowed)',
        );
      });
  }

  function emitMany(ctx: RecorderContext, panels: PanelConfig[], type: PanelEventType): void {
    for (const p of panels) emit(ctx, p, type);
  }

  return {
    recordCreated: (ctx, panels) => emitMany(ctx, panels, 'created'),
    recordEdited: (ctx, panels) => emitMany(ctx, panels, 'edited'),
    recordDeleted: (ctx, panels) => emitMany(ctx, panels, 'deleted'),
    recordCloned: (ctx, panels) => emitMany(ctx, panels, 'cloned'),
    recordViewed: (ctx, panels) => emitMany(ctx, panels, 'viewed'),
    recordPanelDiff(ctx, before, after) {
      const beforeById = new Map(before.map((p) => [p.id, p]));
      const afterById = new Map(after.map((p) => [p.id, p]));
      for (const p of after) {
        const prior = beforeById.get(p.id);
        if (!prior) emit(ctx, p, 'created');
        else if (!panelEqual(prior, p)) emit(ctx, p, 'edited');
      }
      for (const p of before) {
        if (!afterById.has(p.id)) emit(ctx, p, 'deleted');
      }
    },
  };
}

/**
 * No-op recorder for tests / callers that opt out. Returns the same shape so
 * downstream code can stay null-free.
 */
export function noopPanelEventRecorder(): PanelEventRecorder {
  return {
    recordCreated: () => {},
    recordEdited: () => {},
    recordDeleted: () => {},
    recordCloned: () => {},
    recordViewed: () => {},
    recordPanelDiff: () => {},
  };
}
