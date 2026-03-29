export type ApprovalStatus = 'pending' | 'approved' | 'rejected' | 'expired';
/** Mirrors the AdapterAction shape without importing from agent-core */
export interface ApprovalAction {
    type: string;
    targetService?: string;
    params: Record<string, unknown>;
}
export interface ApprovalContext {
    investigationId?: string;
    requestedBy: string;
    /** Human-readable reason the action is being requested */
    reason: string;
}
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
}
export interface SubmitApprovalParams {
    action: ApprovalAction;
    context: ApprovalContext;
    /** TTL in milliseconds; defaults to 24 hours */
    ttlMs?: number;
}
type ResolvedCallback = (request: ApprovalRequest) => void;
export declare class ApprovalStore {
    private readonly requests;
    private readonly callbacks;
    submit(params: SubmitApprovalParams): ApprovalRequest;
    findById(id: string): ApprovalRequest | undefined;
    /** Returns only pending, non-expired requests */
    listPending(): ApprovalRequest[];
    approve(id: string, by: string, roles?: string[]): ApprovalRequest | undefined;
    reject(id: string, by: string, roles?: string[]): ApprovalRequest | undefined;
    /**
     * Admin override: force-approve a request regardless of current status
     * (e.g., re-approve a previously rejected request).
     */
    override(id: string, by: string, roles?: string[]): ApprovalRequest | undefined;
    /** Register a callback invoked whenever a request is approved or rejected */
    onResolved(callback: ResolvedCallback): () => void;
    get size(): number;
    private resolve;
    private markExpiredIfNeeded;
    private notify;
}
export declare const approvalStore: ApprovalStore;
export {};
//# sourceMappingURL=approval-store.d.ts.map
