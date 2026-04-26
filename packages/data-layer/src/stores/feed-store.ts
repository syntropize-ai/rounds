import { randomUUID } from 'crypto';
import type {
  FeedEventType,
  FeedSeverity,
  FeedFeedback,
  HypothesisFeedback,
  ActionFeedback,
  FeedItem,
  FeedbackStats,
  FeedListOptions,
  FeedPage,
} from '../repository/types/feed.js';

export type {
  FeedEventType,
  FeedSeverity,
  FeedStatus,
  FeedFeedback,
  HypothesisFeedback,
  ActionFeedback,
  FeedItem,
  FeedbackStats,
  FeedListOptions,
  FeedPage,
} from '../repository/types/feed.js';

type FeedSubscriber = (item: FeedItem) => void;

export class FeedStore {
  private items: Map<string, FeedItem> = new Map();
  private orderedIds: string[] = [];
  private subscribers: Set<FeedSubscriber> = new Set();
  private readonly tenants = new Map<string, string>();

  add(
    type: FeedEventType,
    title: string,
    summary: string,
    severity: FeedSeverity,
    investigationId?: string,
    tenantId?: string,
  ): FeedItem {
    const item: FeedItem = {
      id: randomUUID(),
      type,
      title,
      summary,
      severity,
      status: 'unread',
      investigationId,
      createdAt: new Date().toISOString(),
    };
    this.items.set(item.id, item);
    this.orderedIds.push(item.id);
    if (tenantId)
      this.tenants.set(item.id, tenantId);
    this.notify(item);
    return item;
  }

  get(id: string): FeedItem | undefined {
    return this.items.get(id);
  }

  list(options: FeedListOptions = {}): FeedPage {
    const { page = 1, limit = 20, type, severity, status, tenantId } = options;

    let filtered = this.orderedIds
      .map((id) => this.items.get(id))
      .filter((item): item is FeedItem => item !== undefined)
      .reverse(); // newest first

    if (tenantId !== undefined)
      filtered = filtered.filter((item) => this.tenants.get(item.id) === tenantId);

    if (type !== undefined)
      filtered = filtered.filter((item) => item.type === type);

    if (severity !== undefined)
      filtered = filtered.filter((item) => item.severity === severity);

    if (status !== undefined)
      filtered = filtered.filter((item) => item.status === status);

    const total = filtered.length;
    const start = (page - 1) * limit;
    const items = filtered.slice(start, start + limit);

    return { items, total, page, limit };
  }

  markRead(id: string): FeedItem | undefined {
    const item = this.items.get(id);
    if (!item)
      return undefined;
    const updated: FeedItem = { ...item, status: 'read' };
    this.items.set(id, updated);
    return updated;
  }

  /** Mark a feed item as followed-up (user navigated from feed into investigation). */
  markFollowedUp(id: string): FeedItem | undefined {
    const item = this.items.get(id);
    if (!item)
      return undefined;
    if (item.followed_up)
      return item;
    const updated: FeedItem = { ...item, followed_up: true };
    this.items.set(id, updated);
    return updated;
  }

  addFeedback(id: string, feedback: FeedFeedback, comment?: string): FeedItem | undefined {
    const item = this.items.get(id);
    if (!item)
      return undefined;
    const updated: FeedItem = {
      ...item,
      feedback,
      ...(comment !== undefined ? { feedbackComment: comment } : {}),
    };
    this.items.set(id, updated);
    return updated;
  }

  /**
   * Record or update a per-hypothesis verdict for a feed item.
   * If feedback for the same `hypothesisId` already exists it is replaced.
   */
  addHypothesisFeedback(id: string, feedback: HypothesisFeedback): FeedItem | undefined {
    const item = this.items.get(id);
    if (!item)
      return undefined;
    const existing = item.hypothesisFeedback ?? [];
    const others = existing.filter((f) => f.hypothesisId !== feedback.hypothesisId);
    const updated: FeedItem = { ...item, hypothesisFeedback: [...others, feedback] };
    this.items.set(id, updated);
    return updated;
  }

  /**
   * Record or update a per-action verdict for a feed item.
   * If feedback for the same `actionId` already exists it is replaced.
   */
  addActionFeedback(id: string, feedback: ActionFeedback): FeedItem | undefined {
    const item = this.items.get(id);
    if (!item)
      return undefined;
    const existing = item.actionFeedback ?? [];
    const others = existing.filter((f) => f.actionId !== feedback.actionId);
    const updated: FeedItem = { ...item, actionFeedback: [...others, feedback] };
    this.items.set(id, updated);
    return updated;
  }

  /** Aggregate feedback statistics across all stored feed items. */
  getStats(): FeedbackStats {
    const all = [...this.items.values()];
    const total = all.length;
    const withFeedback = all.filter((i) => i.feedback !== undefined).length;

    const byVerdict: Record<FeedFeedback, number> = {
      useful: 0,
      not_useful: 0,
      root_cause_correct: 0,
      root_cause_wrong: 0,
      partially_correct: 0,
    };

    let hypCorrect = 0;
    let hypWrong = 0;
    let actHelpful = 0;
    let actNotHelpful = 0;

    for (const item of all) {
      if (item.feedback)
        byVerdict[item.feedback]++;
      for (const hf of item.hypothesisFeedback ?? []) {
        if (hf.verdict === 'correct')
          hypCorrect++;
        else
          hypWrong++;
      }
      for (const af of item.actionFeedback ?? []) {
        if (af.helpful)
          actHelpful++;
        else
          actNotHelpful++;
      }
    }

    const followedUpCount = all.filter((i) => i.followed_up === true).length;
    const proactiveTypes: FeedEventType[] = ['anomaly_detected', 'change_impact'];
    const proactiveItems = all.filter((i) => proactiveTypes.includes(i.type));
    const proactiveHitRate = proactiveItems.length > 0
      ? proactiveItems.filter((i) => i.followed_up === true).length / proactiveItems.length
      : 0;

    return {
      total,
      withFeedback,
      feedbackRate: total === 0 ? 0 : withFeedback / total,
      byVerdict,
      hypothesisVerdicts: { correct: hypCorrect, wrong: hypWrong },
      actionVerdicts: { helpful: actHelpful, notHelpful: actNotHelpful },
      followedUpCount,
      proactiveHitRate,
    };
  }

  getUnreadCount(): number {
    let count = 0;
    for (const item of this.items.values()) {
      if (item.status === 'unread')
        count++;
    }
    return count;
  }

  subscribe(fn: FeedSubscriber): () => void {
    this.subscribers.add(fn);
    return () => {
      this.subscribers.delete(fn);
    };
  }

  private notify(item: FeedItem): void {
    for (const fn of this.subscribers) {
      fn(item);
    }
  }
}

export const feedStore = new FeedStore();
