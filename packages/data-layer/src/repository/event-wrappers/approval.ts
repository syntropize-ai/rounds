import { createLogger } from '@agentic-obs/common/logging';
import type { MaybeAsync, IApprovalRequestRepository } from '../interfaces.js';
import type { ApprovalRequest } from '../types.js';
import type { IGatewayApprovalStore } from '../gateway-interfaces.js';

const log = createLogger('approval-events');

type ResolvedCallback = (request: ApprovalRequest) => void;

/**
 * Wraps an IApprovalRequestRepository with in-memory pub/sub (onResolved()).
 * Implements IGatewayApprovalStore so it's a drop-in replacement for the
 * deprecated ApprovalStore (see ADR-001 §M3).
 */
export class EventEmittingApprovalRepository implements IGatewayApprovalStore {
  private readonly callbacks = new Set<ResolvedCallback>();

  constructor(private readonly repo: IApprovalRequestRepository) {}

  findById(id: string): MaybeAsync<ApprovalRequest | undefined> {
    return this.repo.findById(id);
  }

  listPending(): MaybeAsync<ApprovalRequest[]> {
    return this.repo.listPending();
  }

  async approve(id: string, by: string, roles?: string[]): Promise<ApprovalRequest | undefined> {
    const result = await this.repo.approve(id, by, roles);
    if (result) this.notify(result);
    return result;
  }

  async reject(id: string, by: string, roles?: string[]): Promise<ApprovalRequest | undefined> {
    const result = await this.repo.reject(id, by, roles);
    if (result) this.notify(result);
    return result;
  }

  async override(id: string, by: string, roles?: string[]): Promise<ApprovalRequest | undefined> {
    const result = await this.repo.override(id, by, roles);
    if (result) this.notify(result);
    return result;
  }

  onResolved(callback: ResolvedCallback): () => void {
    this.callbacks.add(callback);
    return () => this.callbacks.delete(callback);
  }

  private notify(request: ApprovalRequest): void {
    // Each callback runs in isolation: a throwing listener is logged with
    // structured context but must not block the remaining listeners (the
    // plan executor's onResolved hook is one of these — losing its signal
    // because an unrelated subscriber threw would leave plan steps stuck
    // in 'paused_for_approval' forever). Preserved from R-5 (#193).
    for (const cb of this.callbacks) {
      try {
        cb(request);
      } catch (err) {
        log.warn(
          {
            requestId: request.id,
            action: request.action.type,
            status: request.status,
            errClass: err instanceof Error ? err.constructor.name : typeof err,
            err: err instanceof Error ? err.message : String(err),
          },
          'approval events: onResolved callback threw — continuing',
        );
      }
    }
  }
}
