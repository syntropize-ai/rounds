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
  | { kind: 'in_progress'; status: InvestigationStatus; investigationId: string }
  | { kind: 'completed_with_plan'; investigationId: string; planId: string }
  | { kind: 'completed'; investigationId: string }
  | { kind: 'failed'; investigationId: string };

export function classifyInvestigation(args: {
  investigationId?: string;
  status?: InvestigationStatus;
  pendingPlanId?: string;
}): InvestigationIndicator {
  const { investigationId, status, pendingPlanId } = args;
  if (!investigationId) return { kind: 'idle' };
  if (status && IN_PROGRESS_INVESTIGATION_STATUSES.has(status)) {
    return { kind: 'in_progress', status, investigationId };
  }
  if (status === 'failed') return { kind: 'failed', investigationId };
  if (pendingPlanId) return { kind: 'completed_with_plan', investigationId, planId: pendingPlanId };
  if (status === 'completed') return { kind: 'completed', investigationId };
  // Status unknown yet (still loading) but we have an investigationId: treat as in-progress
  // so the UI shows the spinner rather than nothing.
  return { kind: 'in_progress', status: status ?? 'planning', investigationId };
}

/**
 * 5s while any investigation is active, 30s otherwise. Hidden documents
 * use the larger interval to avoid background work.
 */
export function nextPollIntervalMs(args: { anyActive: boolean; visible: boolean }): number {
  if (!args.visible) return 30_000;
  return args.anyActive ? 5_000 : 30_000;
}
