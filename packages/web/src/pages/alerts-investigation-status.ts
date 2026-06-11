import type { InvestigationStatus } from '../api/types.js';

export const IN_PROGRESS_INVESTIGATION_STATUSES: ReadonlySet<InvestigationStatus> = new Set([
  'planning',
  'investigating',
  'evidencing',
  'explaining',
  'acting',
  'verifying',
]);

export type InvestigationIndicator =
  | { kind: 'idle' }
  | { kind: 'in_progress'; status: InvestigationStatus; investigationId?: string }
  | { kind: 'completed_with_plan'; investigationId: string; planId: string }
  | { kind: 'completed'; investigationId: string }
  | { kind: 'failed'; investigationId?: string; reason?: string };

export function classifyInvestigation(args: {
  investigationId?: string;
  investigationStartedAt?: string;
  investigationFailedAt?: string;
  investigationFailureReason?: string;
  status?: InvestigationStatus;
  pendingPlanId?: string;
}): InvestigationIndicator {
  const {
    investigationId,
    investigationStartedAt,
    investigationFailedAt,
    investigationFailureReason,
    status,
    pendingPlanId,
  } = args;
  if (!investigationId) {
    if (investigationStartedAt) return { kind: 'in_progress', status: 'investigating' };
    if (investigationFailedAt) return { kind: 'failed', reason: investigationFailureReason };
    return { kind: 'idle' };
  }
  if (status && IN_PROGRESS_INVESTIGATION_STATUSES.has(status)) {
    return { kind: 'in_progress', status, investigationId };
  }
  if (status === 'failed') return { kind: 'failed', investigationId, reason: investigationFailureReason };
  if (pendingPlanId) return { kind: 'completed_with_plan', investigationId, planId: pendingPlanId };
  if (status === 'completed') return { kind: 'completed', investigationId };
  // If the rule still has an investigationId but the row can no longer be
  // loaded, do not leave the alert looking permanently in-progress. This can
  // happen after an investigation is deleted or a local dev DB is edited.
  return { kind: 'idle' };
}

/**
 * 5s while any investigation is active, 30s otherwise. Hidden documents
 * use the larger interval to avoid background work.
 */
export function nextPollIntervalMs(args: { anyActive: boolean; visible: boolean }): number {
  if (!args.visible) return 30_000;
  return args.anyActive ? 5_000 : 30_000;
}
