import { randomUUID } from 'crypto';

// -- Types

export type ApprovalStatus = 'pending' | 'approved' | 'rejected' | 'expired';

/** Mirrors the AdapterAction shape without importing from agent-core */
export interface ApprovalAction {
  type: string;
  targetService: string;
  params: Record<string, unknown>;
}

export interface ApprovalContext {
  investigationId?: string;
  requestedBy: string;
  /** Human-readable reason the action is being requested */
  reason: string;
  [key: string]: unknown;
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

// -- Store

type ResolvedCallback = (request: ApprovalRequest) => void;

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

export class ApprovalStore {
  private requests = new Map<string, ApprovalRequest>();
  private readonly callbacks: Set<ResolvedCallback> = new Set();

  submit(params: SubmitApprovalParams): ApprovalRequest {
    const now = new Date();
    const expiresAt = new Date(now.getTime() + (params.ttlMs ?? DEFAULT_TTL_MS));
    const request: ApprovalRequest = {
      id: randomUUID(),
      action: params.action,
      context: params.context,
      status: 'pending',
      createdAt: now.toISOString(),
      expiresAt: expiresAt.toISOString(),
    };
    this.requests.set(request.id, request);
    return request;
  }

  findById(id: string): ApprovalRequest | undefined {
    const req = this.requests.get(id);
    if (!req)
      return undefined;
    return this.markExpiredIfNeeded(req);
  }

  /** Returns only pending, non-expired requests */
  listPending(): ApprovalRequest[] {
    const results: ApprovalRequest[] = [];
    for (const req of this.requests.values()) {
      const current = this.markExpiredIfNeeded(req);
      if (current.status === 'pending')
        results.push(current);
    }
    return results.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  approve(id: string, by: string, roles?: string[]): ApprovalRequest | undefined {
    return this.resolve(id, 'approved', by, roles);
  }

  reject(id: string, by: string, roles?: string[]): ApprovalRequest | undefined {
    return this.resolve(id, 'rejected', by, roles);
  }

  /**
   * Admin override: force-approve a request regardless of current status
   * e.g. approve a previously rejected request.
   */
  override(id: string, by: string, roles?: string[]): ApprovalRequest | undefined {
    const req = this.requests.get(id);
    if (!req)
      return undefined;
    const updated: ApprovalRequest = {
      ...req,
      status: 'approved',
      resolvedAt: new Date().toISOString(),
      resolvedBy: by,
      resolvedByRoles: roles,
    };
    this.requests.set(id, updated);
    this.notify(updated);
    return updated;
  }

  /** Register a callback invoked whenever a request is approved or rejected */
  onResolved(callback: ResolvedCallback): () => void {
    this.callbacks.add(callback);
    return () => this.callbacks.delete(callback);
  }

  get size(): number {
    return this.requests.size;
  }

  // -- Private helpers

  private resolve(id: string, status: 'approved' | 'rejected', by: string, roles?: string[]): ApprovalRequest | undefined {
    const req = this.requests.get(id);
    if (!req)
      return undefined;

    // Expire first to check if it's still actionable
    const current = this.markExpiredIfNeeded(req);
    if (current.status !== 'pending')
      return undefined; // already resolved or expired

    const updated: ApprovalRequest = {
      ...current,
      status,
      resolvedAt: new Date().toISOString(),
      resolvedBy: by,
      resolvedByRoles: roles,
    };
    this.requests.set(id, updated);
    this.notify(updated);
    return updated;
  }

  private markExpiredIfNeeded(req: ApprovalRequest): ApprovalRequest {
    if (req.status !== 'pending')
      return req;

    if (new Date(req.expiresAt) <= new Date()) {
      const expired: ApprovalRequest = { ...req, status: 'expired' };
      this.requests.set(req.id, expired);
      return expired;
    }

    return req;
  }

  private notify(request: ApprovalRequest): void {
    for (const cb of this.callbacks)
      cb(request);
  }
}

export const approvalStore = new ApprovalStore();
