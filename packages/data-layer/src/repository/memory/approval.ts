import { randomUUID } from 'crypto';
import type {
  ApprovalAction,
  ApprovalContext,
  ApprovalRequest,
  ApprovalStatus,
} from '../types.js';
import type {
  ApprovalScopeFilter,
  IApprovalRequestRepository,
} from '../interfaces.js';
import type { IGatewayApprovalStore } from '../gateway-interfaces.js';

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

/**
 * In-memory implementation of `IApprovalRequestRepository`. Intended for
 * tests and the gateway's no-database default mode. Mirrors the SQLite/
 * Postgres semantics including `markExpiredIfNeeded` on read (preserved
 * from the deprecated ApprovalStore).
 *
 * Event emission (`onResolved`) lives on `EventEmittingApprovalRepository`,
 * not here — see ADR-001 §M3.
 */
export class InMemoryApprovalRequestRepository
  implements IApprovalRequestRepository, IGatewayApprovalStore
{
  private requests = new Map<string, ApprovalRequest>();

  async findById(id: string): Promise<ApprovalRequest | undefined> {
    const req = this.requests.get(id);
    if (!req) return undefined;
    return this.markExpiredIfNeeded(req);
  }

  async submit(params: {
    action: ApprovalAction;
    context: ApprovalContext;
    ttlMs?: number;
    opsConnectorId?: string | null;
    targetNamespace?: string | null;
    requesterTeamId?: string | null;
  }): Promise<ApprovalRequest> {
    const now = new Date();
    const expiresAt = new Date(now.getTime() + (params.ttlMs ?? DEFAULT_TTL_MS));
    const request: ApprovalRequest = {
      id: randomUUID(),
      action: params.action,
      context: params.context,
      status: 'pending',
      createdAt: now.toISOString(),
      expiresAt: expiresAt.toISOString(),
      opsConnectorId: params.opsConnectorId ?? null,
      targetNamespace: params.targetNamespace ?? null,
      requesterTeamId: params.requesterTeamId ?? null,
    };
    this.requests.set(request.id, request);
    return request;
  }

  async listPending(): Promise<ApprovalRequest[]> {
    const results: ApprovalRequest[] = [];
    for (const req of this.requests.values()) {
      const current = this.markExpiredIfNeeded(req);
      if (current.status === 'pending') results.push(current);
    }
    return results.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async list(
    _orgId: string,
    opts?: { scopeFilter?: ApprovalScopeFilter; status?: ApprovalStatus | ApprovalStatus[] },
  ): Promise<ApprovalRequest[]> {
    // The in-memory variant has no orgId column — used by tests and the
    // single-tenant default mode. Apply status/scope filters in-process.
    const status = opts?.status;
    const filter = opts?.scopeFilter;

    if (filter && filter.kind === 'narrow') {
      const hasAny =
        (filter.uids?.size ?? 0) > 0
        || (filter.connectors?.size ?? 0) > 0
        || (filter.nsPairs?.length ?? 0) > 0
        || (filter.teams?.size ?? 0) > 0;
      if (!hasAny) return [];
    }

    const out: ApprovalRequest[] = [];
    for (const req of this.requests.values()) {
      const current = this.markExpiredIfNeeded(req);

      if (status !== undefined) {
        if (Array.isArray(status)) {
          if (status.length === 0) return [];
          if (!status.includes(current.status)) continue;
        } else if (current.status !== status) {
          continue;
        }
      }

      if (filter && filter.kind === 'narrow') {
        const uidMatch = filter.uids?.has(current.id) ?? false;
        const connMatch = current.opsConnectorId != null
          && (filter.connectors?.has(current.opsConnectorId) ?? false);
        const nsMatch = current.opsConnectorId != null
          && current.targetNamespace != null
          && (filter.nsPairs ?? []).some(
            (p) => p.connectorId === current.opsConnectorId && p.ns === current.targetNamespace,
          );
        const teamMatch = current.requesterTeamId != null
          && (filter.teams?.has(current.requesterTeamId) ?? false);
        if (!uidMatch && !connMatch && !nsMatch && !teamMatch) continue;
      }

      out.push(current);
    }
    return out.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  async approve(id: string, by: string, roles?: string[]): Promise<ApprovalRequest | undefined> {
    return this.resolve(id, 'approved', by, roles);
  }

  async reject(id: string, by: string, roles?: string[]): Promise<ApprovalRequest | undefined> {
    return this.resolve(id, 'rejected', by, roles);
  }

  /**
   * Admin override: force-approve a request regardless of current status
   * (e.g. approve a previously rejected request).
   */
  async override(id: string, by: string, roles?: string[]): Promise<ApprovalRequest | undefined> {
    const req = this.requests.get(id);
    if (!req) return undefined;
    const updated: ApprovalRequest = {
      ...req,
      status: 'approved',
      resolvedAt: new Date().toISOString(),
      resolvedBy: by,
      resolvedByRoles: roles,
    };
    this.requests.set(id, updated);
    return updated;
  }

  get size(): number {
    return this.requests.size;
  }

  private async resolve(
    id: string,
    status: 'approved' | 'rejected',
    by: string,
    roles?: string[],
  ): Promise<ApprovalRequest | undefined> {
    const req = this.requests.get(id);
    if (!req) return undefined;

    // Expire first to check if it's still actionable
    const current = this.markExpiredIfNeeded(req);
    if (current.status !== 'pending') return undefined;

    const updated: ApprovalRequest = {
      ...current,
      status,
      resolvedAt: new Date().toISOString(),
      resolvedBy: by,
      resolvedByRoles: roles,
    };
    this.requests.set(id, updated);
    return updated;
  }

  private markExpiredIfNeeded(req: ApprovalRequest): ApprovalRequest {
    if (req.status !== 'pending') return req;
    if (new Date(req.expiresAt) <= new Date()) {
      const expired: ApprovalRequest = { ...req, status: 'expired' };
      this.requests.set(req.id, expired);
      return expired;
    }
    return req;
  }
}
