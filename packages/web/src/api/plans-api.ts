/**
 * Typed API client for `/api/plans` (Phase 5 of the auto-remediation
 * design). The shape mirrors the server route surface in
 * `packages/api-gateway/src/routes/plans.ts` — keep them in sync.
 */

import { apiClient } from './rest-api.js';

export type RemediationPlanStatus =
  | 'draft'
  | 'pending_approval'
  | 'approved'
  | 'rejected'
  | 'executing'
  | 'completed'
  | 'failed'
  | 'expired'
  | 'cancelled';

export type RemediationPlanStepStatus =
  | 'pending'
  | 'approved'
  | 'executing'
  | 'done'
  | 'failed'
  | 'skipped';

export interface RemediationPlanStep {
  id: string;
  planId: string;
  ordinal: number;
  kind: string;
  commandText: string;
  paramsJson: Record<string, unknown>;
  dryRunText: string | null;
  riskNote: string | null;
  continueOnError: boolean;
  status: RemediationPlanStepStatus;
  approvalRequestId: string | null;
  executedAt: string | null;
  outputText: string | null;
  errorText: string | null;
}

export interface RemediationPlan {
  id: string;
  orgId: string;
  investigationId: string;
  rescueForPlanId: string | null;
  summary: string;
  status: RemediationPlanStatus;
  autoEdit: boolean;
  approvalRequestId: string | null;
  createdBy: string;
  createdAt: string;
  expiresAt: string;
  resolvedAt: string | null;
  resolvedBy: string | null;
  steps: RemediationPlanStep[];
}

export type PlanExecutorOutcome =
  | { kind: 'paused_for_approval'; stepOrdinal: number; approvalRequestId: string }
  | { kind: 'completed' }
  | { kind: 'failed'; failedOrdinal: number; reason: string }
  | { kind: 'cancelled' };

export interface ApproveResponse {
  outcome: PlanExecutorOutcome;
  plan: RemediationPlan | null;
}

export interface RetryStepResponse {
  outcome: PlanExecutorOutcome;
  plan: RemediationPlan | null;
}

export const plansApi = {
  list(opts: { status?: RemediationPlanStatus; investigationId?: string } = {}): Promise<{ data: RemediationPlan[] }> {
    const qs = new URLSearchParams();
    if (opts.status) qs.set('status', opts.status);
    if (opts.investigationId) qs.set('investigationId', opts.investigationId);
    const path = qs.toString() ? `/plans?${qs}` : '/plans';
    return apiClient.get<RemediationPlan[]>(path);
  },
  get(id: string): Promise<{ data: RemediationPlan }> {
    return apiClient.get<RemediationPlan>(`/plans/${encodeURIComponent(id)}`);
  },
  approve(id: string, autoEdit: boolean): Promise<{ data: ApproveResponse }> {
    return apiClient.post<ApproveResponse>(`/plans/${encodeURIComponent(id)}/approve`, { autoEdit });
  },
  reject(id: string): Promise<{ data: RemediationPlan | null }> {
    return apiClient.post<RemediationPlan | null>(`/plans/${encodeURIComponent(id)}/reject`, {});
  },
  cancel(id: string): Promise<{ data: RemediationPlan | null }> {
    return apiClient.post<RemediationPlan | null>(`/plans/${encodeURIComponent(id)}/cancel`, {});
  },
  retryStep(id: string, ordinal: number): Promise<{ data: RetryStepResponse }> {
    return apiClient.post<RetryStepResponse>(
      `/plans/${encodeURIComponent(id)}/steps/${ordinal}/retry`,
      {},
    );
  },
};
