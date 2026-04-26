import { eq, and, sql } from 'drizzle-orm';
import { randomUUID } from 'crypto';
import type { SqliteClient } from '../../db/sqlite-client.js';
import { feedItems } from '../../db/sqlite-schema.js';
import type {
  IFeedItemRepository,
} from '../interfaces.js';
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

type FeedRow = typeof feedItems.$inferSelect;

function rowToFeedItem(row: FeedRow): FeedItem {
  return {
    id: row.id,
    type: row.type as FeedEventType,
    title: row.title,
    summary: row.summary,
    severity: row.severity as FeedSeverity,
    status: row.status as FeedItem['status'],
    feedback: (row.feedback as FeedFeedback) ?? undefined,
    feedbackComment: row.feedbackComment ?? undefined,
    hypothesisFeedback: (row.hypothesisFeedback as HypothesisFeedback[]) ?? undefined,
    actionFeedback: (row.actionFeedback as ActionFeedback[]) ?? undefined,
    investigationId: row.investigationId ?? undefined,
    followed_up: row.followedUp,
    createdAt: row.createdAt,
  };
}

export class SqliteFeedItemRepository implements IFeedItemRepository {
  constructor(private readonly db: SqliteClient) {}

  async add(
    type: FeedEventType,
    title: string,
    summary: string,
    severity: FeedSeverity,
    investigationId?: string,
    tenantId?: string,
  ): Promise<FeedItem> {
    const id = `feed_${randomUUID().slice(0, 8)}`;
    const now = new Date().toISOString();
    const [row] = await this.db
      .insert(feedItems)
      .values({
        id,
        tenantId: tenantId ?? 'default',
        type,
        title,
        summary,
        severity,
        status: 'unread',
        investigationId,
        createdAt: now,
      })
      .returning();
    return rowToFeedItem(row!);
  }

  async get(id: string): Promise<FeedItem | undefined> {
    const [row] = await this.db.select().from(feedItems).where(eq(feedItems.id, id));
    return row ? rowToFeedItem(row) : undefined;
  }

  async list(options: FeedListOptions = {}): Promise<FeedPage> {
    const page = options.page ?? 1;
    const limit = options.limit ?? 50;
    const offset = (page - 1) * limit;

    const conditions: ReturnType<typeof eq>[] = [];
    if (options.type) conditions.push(eq(feedItems.type, options.type));
    if (options.severity) conditions.push(eq(feedItems.severity, options.severity));
    if (options.status) conditions.push(eq(feedItems.status, options.status));
    if (options.tenantId) conditions.push(eq(feedItems.tenantId, options.tenantId));

    const where = conditions.length ? and(...conditions) : undefined;

    const [countResult] = await this.db
      .select({ count: sql<number>`count(*)` })
      .from(feedItems)
      .where(where);
    const total = Number(countResult?.count ?? 0);

    const rows = await this.db
      .select()
      .from(feedItems)
      .where(where)
      .orderBy(sql`${feedItems.createdAt} desc`)
      .limit(limit)
      .offset(offset);

    return { items: rows.map(rowToFeedItem), total, page, limit };
  }

  async markRead(id: string): Promise<FeedItem | undefined> {
    const [row] = await this.db
      .update(feedItems)
      .set({ status: 'read' })
      .where(eq(feedItems.id, id))
      .returning();
    return row ? rowToFeedItem(row) : undefined;
  }

  async markFollowedUp(id: string): Promise<FeedItem | undefined> {
    const [row] = await this.db
      .update(feedItems)
      .set({ followedUp: true })
      .where(eq(feedItems.id, id))
      .returning();
    return row ? rowToFeedItem(row) : undefined;
  }

  async addFeedback(id: string, feedback: FeedFeedback, comment?: string): Promise<FeedItem | undefined> {
    const sets: Record<string, unknown> = { feedback, status: 'read' };
    if (comment !== undefined) sets.feedbackComment = comment;
    const [row] = await this.db
      .update(feedItems)
      .set(sets)
      .where(eq(feedItems.id, id))
      .returning();
    return row ? rowToFeedItem(row) : undefined;
  }

  async addHypothesisFeedback(id: string, feedback: HypothesisFeedback): Promise<FeedItem | undefined> {
    const existing = await this.get(id);
    if (!existing) return undefined;

    const current = existing.hypothesisFeedback ?? [];
    const idx = current.findIndex((h) => h.hypothesisId === feedback.hypothesisId);
    if (idx >= 0) {
      current[idx] = feedback;
    } else {
      current.push(feedback);
    }

    const [row] = await this.db
      .update(feedItems)
      .set({ hypothesisFeedback: current })
      .where(eq(feedItems.id, id))
      .returning();
    return row ? rowToFeedItem(row) : undefined;
  }

  async addActionFeedback(id: string, feedback: ActionFeedback): Promise<FeedItem | undefined> {
    const existing = await this.get(id);
    if (!existing) return undefined;

    const current = existing.actionFeedback ?? [];
    const idx = current.findIndex((a) => a.actionId === feedback.actionId);
    if (idx >= 0) {
      current[idx] = feedback;
    } else {
      current.push(feedback);
    }

    const [row] = await this.db
      .update(feedItems)
      .set({ actionFeedback: current })
      .where(eq(feedItems.id, id))
      .returning();
    return row ? rowToFeedItem(row) : undefined;
  }

  async getUnreadCount(): Promise<number> {
    const [result] = await this.db
      .select({ count: sql<number>`count(*)` })
      .from(feedItems)
      .where(eq(feedItems.status, 'unread'));
    return Number(result?.count ?? 0);
  }

  async getStats(): Promise<FeedbackStats> {
    const allRows = await this.db.select().from(feedItems);
    const items = allRows.map(rowToFeedItem);
    const total = items.length;
    const withFeedback = items.filter((i) => i.feedback).length;

    const byVerdict: Record<FeedFeedback, number> = {
      useful: 0,
      not_useful: 0,
      root_cause_correct: 0,
      root_cause_wrong: 0,
      partially_correct: 0,
    };
    for (const item of items) {
      if (item.feedback) {
        byVerdict[item.feedback] = (byVerdict[item.feedback] ?? 0) + 1;
      }
    }

    let hypothesisCorrect = 0;
    let hypothesisWrong = 0;
    let actionHelpful = 0;
    let actionNotHelpful = 0;
    let followedUpCount = 0;

    for (const item of items) {
      if (item.followed_up) followedUpCount++;
      if (item.hypothesisFeedback) {
        for (const h of item.hypothesisFeedback) {
          if (h.verdict === 'correct') hypothesisCorrect++;
          else hypothesisWrong++;
        }
      }
      if (item.actionFeedback) {
        for (const a of item.actionFeedback) {
          if (a.helpful) actionHelpful++;
          else actionNotHelpful++;
        }
      }
    }

    const proactiveTypes: FeedEventType[] = ['anomaly_detected', 'change_impact'];
    const proactiveItems = items.filter((i) => proactiveTypes.includes(i.type as FeedEventType));
    const proactiveHitRate = proactiveItems.length > 0
      ? proactiveItems.filter((i) => i.followed_up === true).length / proactiveItems.length
      : 0;

    return {
      total,
      withFeedback,
      feedbackRate: total > 0 ? withFeedback / total : 0,
      byVerdict,
      hypothesisVerdicts: { correct: hypothesisCorrect, wrong: hypothesisWrong },
      actionVerdicts: { helpful: actionHelpful, notHelpful: actionNotHelpful },
      followedUpCount,
      proactiveHitRate,
    };
  }
}
