import { createLogger } from '@agentic-obs/common/logging';
import type { MaybeAsync, IApprovalRequestRepository } from '../interfaces.js';

const log = createLogger('approval-events');
import type { ApprovalRequest, ApprovalAction, ApprovalContext } from '../../stores/approval-store.js';
import type { IGatewayApprovalStore } from '../../stores/interfaces.js';

type ResolvedCallback = (request: ApprovalRequest) => void;

/**
 * Wraps an IApprovalRequestRepository with in-memory pub/sub (onResolved()).
 * Implements IGatewayApprovalStore so it's a drop-in replacement for ApprovalStore.
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
    for (const cb of this.callbacks) {
      try {
        cb(request);
      } catch (err) {
        log.warn({ err }, 'approval resolved callback threw');
      }
    }
  }
}
