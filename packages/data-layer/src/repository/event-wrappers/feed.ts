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
} from '../types/feed.js';
import type { IGatewayFeedStore } from '../../stores/interfaces.js';

type FeedSubscriber = (item: FeedItem) => void;

/**
 * Wraps an IFeedItemRepository with in-memory pub/sub (subscribe()).
 * Implements IGatewayFeedStore so it's a drop-in replacement for FeedStore.
 */
export class EventEmittingFeedRepository implements IGatewayFeedStore {
  private readonly subscribers = new Set<FeedSubscriber>();

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
    this.notify(item);
    return item;
  }

  get(id: string): MaybeAsync<FeedItem | undefined> {
    return this.repo.get(id);
  }

  list(options?: FeedListOptions): MaybeAsync<FeedPage> {
    return this.repo.list(options);
  }

  markRead(id: string): MaybeAsync<FeedItem | undefined> {
    return this.repo.markRead(id);
  }

  markFollowedUp(id: string): MaybeAsync<FeedItem | undefined> {
    return this.repo.markFollowedUp(id);
  }

  addFeedback(id: string, feedback: FeedFeedback, comment?: string): MaybeAsync<FeedItem | undefined> {
    return this.repo.addFeedback(id, feedback, comment);
  }

  addHypothesisFeedback(id: string, feedback: HypothesisFeedback): MaybeAsync<FeedItem | undefined> {
    return this.repo.addHypothesisFeedback(id, feedback);
  }

  addActionFeedback(id: string, feedback: ActionFeedback): MaybeAsync<FeedItem | undefined> {
    return this.repo.addActionFeedback(id, feedback);
  }

  getUnreadCount(): MaybeAsync<number> {
    return this.repo.getUnreadCount();
  }

  getStats(): MaybeAsync<FeedbackStats> {
    return this.repo.getStats();
  }

  subscribe(fn: FeedSubscriber): () => void {
    this.subscribers.add(fn);
    return () => {
      this.subscribers.delete(fn);
    };
  }

  private notify(item: FeedItem): void {
    for (const fn of this.subscribers) {
      try {
        fn(item);
      } catch {
        // Subscriber callbacks must not be able to break notification delivery
        // to other subscribers. Swallow errors by design.
      }
    }
  }
}
