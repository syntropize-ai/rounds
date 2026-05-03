/**
 * notification_dispatch — one row per (fingerprint, contactPointId, groupKey)
 * tracking when we last sent a notification for an alert. Used by the
 * notification consumer to enforce groupWait / groupInterval / repeatInterval.
 */

export interface NotificationDispatchRow {
  id: string;
  orgId: string;
  fingerprint: string;
  contactPointId: string;
  groupKey: string;
  lastSentAt: string;
  sentCount: number;
}

export interface UpsertDispatchInput {
  orgId: string;
  fingerprint: string;
  contactPointId: string;
  groupKey: string;
  /** ISO timestamp of the just-completed send. */
  sentAt: string;
}

export interface INotificationDispatchRepository {
  findByKey(
    orgId: string,
    fingerprint: string,
    contactPointId: string,
    groupKey: string,
  ): Promise<NotificationDispatchRow | undefined>;

  /**
   * Insert if no row exists for the (fingerprint, contactPointId, groupKey)
   * triple, otherwise update last_sent_at = sentAt and increment sent_count.
   */
  upsertSent(input: UpsertDispatchInput): Promise<NotificationDispatchRow>;
}
