// Domain types for persistence - these mirror the DB schema columns and
// fill gaps for types not defined in @agentic-obs/common.

export type ApprovalStatus = 'pending' | 'approved' | 'rejected' | 'expired';

export interface ApprovalAction {
  type: string;
  targetService: string;
  params: Record<string, unknown>;
}

export interface ApprovalContext {
  investigationId?: string;
  requestedBy: string;
  reason: string;
  [key: string]: unknown;
}

/**
 * Gateway-level approval request. Used by `IApprovalRequestRepository` and
 * the event-emitting wrapper. Moved here from the deprecated approval-store
 * in M3 (ADR-001).
 */
export interface ApprovalRequest {
  id: string;
  action: ApprovalAction;
  context: ApprovalContext;
  status: ApprovalStatus;
  createdAt: string;
  /** ISO timestamp when the approval request expires */
  expiresAt: string;
  resolvedAt?: string;
  resolvedBy?: string;
  /** Roles held by the user who approved/rejected this request */
  resolvedByRoles?: string[];
  /** ops connector this approval gates (NULL for non-ops approvals). See approvals-multi-team-scope §3.2. */
  opsConnectorId?: string | null;
  /** kubernetes namespace (NULL for cluster-scoped plans). See approvals-multi-team-scope §3.2. */
  targetNamespace?: string | null;
  /** team that owns the originating investigation (NULL for SA / pre-multi-team). */
  requesterTeamId?: string | null;
}

export interface SubmitApprovalParams {
  action: ApprovalAction;
  context: ApprovalContext;
  /** TTL in milliseconds, defaults to 24 hours */
  ttlMs?: number;
}

export interface ApprovalRecord {
  id: string;
  tenantId: string;
  actionType: string;
  action: ApprovalAction;
  context: ApprovalContext;
  requestedBy: string;
  resolvedBy?: string;
  resolvedByRoles?: string[];
  status: ApprovalStatus;
  params: Record<string, unknown>;
  expiresAt: string;
  createdAt: string;
  resolvedAt?: string;
}

export interface FeedEvent {
  id: string;
  tenantId: string;
  type: string;
  title: string;
  summary?: string;
  severity?: string;
  metadata?: Record<string, unknown>;
  createdAt: string;
}

export interface Case {
  id: string;
  tenantId: string;
  title: string;
  symptoms: string[];
  rootCause: string;
  resolution: string;
  services: string[];
  tags: string[];
  evidenceRefs: string[];
  actions: string[];
  outcome?: string;
  createdAt: string;
}
