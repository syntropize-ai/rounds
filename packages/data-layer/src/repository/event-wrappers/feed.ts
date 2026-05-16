import type { MaybeAsync, IFeedItemRepository } from '../interfaces.js';
import type {
  FeedItem,
  FeedPage,
  FeedListOptions,
  FeedEventType,
  FeedSeverity,
  FeedFeedback,
  HypothesisFeedback,
  ActionFeedback,
  FeedbackStats,
  FeedTenantOptions,
} from '../types/feed.js';
import type { IGatewayFeedStore } from '../gateway-interfaces.js';

type FeedSubscriber = (item: FeedItem) => void;
type FeedSubscriberRecord = { fn: FeedSubscriber; tenantId?: string };

/**
 * Wraps an IFeedItemRepository with in-memory pub/sub (subscribe()).
 * Implements IGatewayFeedStore so it's a drop-in replacement for FeedStore.
 */
export class EventEmittingFeedRepository implements IGatewayFeedStore {
  private readonly subscribers = new Set<FeedSubscriberRecord>();

  constructor(private readonly repo: IFeedItemRepository) {}

  async add(
    type: FeedEventType,
    title: string,
    summary: string,
    severity: FeedSeverity,
    investigationId?: string,
    tenantId?: string,
  ): Promise<FeedItem> {
    const item = await this.repo.add(type, title, summary, severity, investigationId, tenantId);
    this.notify(item, tenantId);
    return item;
  }

  get(id: string, options?: FeedTenantOptions): MaybeAsync<FeedItem | undefined> {
    return this.repo.get(id, options);
  }

  list(options?: FeedListOptions): MaybeAsync<FeedPage> {
    return this.repo.list(options);
  }

  markRead(id: string, options?: FeedTenantOptions): MaybeAsync<FeedItem | undefined> {
    return this.repo.markRead(id, options);
  }

  markFollowedUp(id: string, options?: FeedTenantOptions): MaybeAsync<FeedItem | undefined> {
    return this.repo.markFollowedUp(id, options);
  }

  addFeedback(id: string, feedback: FeedFeedback, comment?: string, options?: FeedTenantOptions): MaybeAsync<FeedItem | undefined> {
    return this.repo.addFeedback(id, feedback, comment, options);
  }

  addHypothesisFeedback(id: string, feedback: HypothesisFeedback, options?: FeedTenantOptions): MaybeAsync<FeedItem | undefined> {
    return this.repo.addHypothesisFeedback(id, feedback, options);
  }

  addActionFeedback(id: string, feedback: ActionFeedback, options?: FeedTenantOptions): MaybeAsync<FeedItem | undefined> {
    return this.repo.addActionFeedback(id, feedback, options);
  }

  getUnreadCount(options?: FeedTenantOptions): MaybeAsync<number> {
    return this.repo.getUnreadCount(options);
  }

  getStats(options?: FeedTenantOptions): MaybeAsync<FeedbackStats> {
    return this.repo.getStats(options);
  }

  subscribe(fn: FeedSubscriber, options: FeedTenantOptions = {}): () => void {
    const record: FeedSubscriberRecord = { fn, tenantId: options.tenantId };
    this.subscribers.add(record);
    return () => {
      this.subscribers.delete(record);
    };
  }

  private notify(item: FeedItem, tenantId?: string): void {
    for (const { fn, tenantId: subscriberTenantId } of this.subscribers) {
      if (subscriberTenantId !== undefined && subscriberTenantId !== tenantId)
        continue;
      try {
        fn(item);
      } catch {
        // Subscriber callbacks must not be able to break notification delivery
        // to other subscribers. Swallow errors by design.
      }
    }
  }
}
