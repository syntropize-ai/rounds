/**
 * Turning what the product saved into what the scorer grades.
 *
 * The interesting decision here is not the field mapping — it is which
 * failures count as the product's and which count as the harness's. That line
 * decides the denominator, and moving it is the easiest way to publish a
 * flattering number without anyone editing an accuracy calculation.
 *
 * The rule: a run is INVALID only when we cannot tell what the product would
 * have done. The fault failing to inject, the cluster dying, the API being
 * unreachable — those tell us nothing about answer quality and are excluded.
 * Everything the product did or failed to do while healthy is graded, including
 * refusing to investigate, crashing, and running out of time. Those are all
 * "did not produce a verified root cause", which is exactly what UNRESOLVED
 * means. Filing them as INVALID would quietly delete the product's worst runs
 * from the denominator.
 */

import type { ScoredReport } from '../scoring/score.js';

/** The slice of a saved report the scorer reads. */
export interface SavedReportShape {
  provenance?: {
    rootCauseGate?: {
      status?: 'passed' | 'unresolved';
      rootCause?: { status?: string; object?: string; field?: string; cause?: string };
      confidence?: number;
      ruledOut?: string[];
    };
  };
}

/**
 * Map a saved report onto the scorer's input.
 *
 * A report with no gate result is not a missing run — it is a run that never
 * reached a verified root cause. It grades as unresolved.
 */
export function toScoredReport(saved: SavedReportShape | null): ScoredReport {
  const gate = saved?.provenance?.rootCauseGate;
  if (!gate) return { gateStatus: 'unresolved' };
  return {
    gateStatus: gate.status ?? 'unresolved',
    ...(gate.rootCause ? { rootCause: gate.rootCause } : {}),
    ...(typeof gate.confidence === 'number' ? { confidence: gate.confidence } : {}),
    ...(gate.ruledOut ? { ruledOut: gate.ruledOut } : {}),
  };
}

/** Why a run could not be graded. Every value here excludes it from the denominator. */
export type InvalidReason =
  /** The fault did not become visible in the product's data sources. */
  | 'fault-not-observable'
  /** The product's API was not reachable, so we never asked. */
  | 'api-unreachable'
  /** Reverting failed; the cluster state is unknown from here on. */
  | 'revert-failed';
