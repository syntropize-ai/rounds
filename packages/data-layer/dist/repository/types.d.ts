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
export type SharePermission = 'view_only' | 'can_comment';
export interface ShareLink {
  id: string;
  investigationId: string;
  token: string;
  createdBy: string;
  permission: SharePermission;
  expiresAt: string | null;
  createdAt: string;
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
//# sourceMappingURL=types.d.ts.map
