import { and, eq } from 'drizzle-orm';
import { randomUUID } from 'crypto';
import type { SqliteClient } from '../../db/sqlite-client.js';
import { notificationDispatch } from '../../db/sqlite-schema.js';
import type {
  INotificationDispatchRepository,
  NotificationDispatchRow,
  UpsertDispatchInput,
} from '../types/notification-dispatch.js';

type Row = typeof notificationDispatch.$inferSelect;

function rowToDomain(row: Row): NotificationDispatchRow {
  return {
    id: row.id,
    orgId: row.orgId,
    fingerprint: row.fingerprint,
    contactPointId: row.contactPointId,
    groupKey: row.groupKey,
    lastSentAt: row.lastSentAt,
    sentCount: row.sentCount,
  };
}

export class SqliteNotificationDispatchRepository implements INotificationDispatchRepository {
  constructor(private readonly db: SqliteClient) {}

  async findByKey(
    orgId: string,
    fingerprint: string,
    contactPointId: string,
    groupKey: string,
  ): Promise<NotificationDispatchRow | undefined> {
    const rows = await this.db
      .select()
      .from(notificationDispatch)
      .where(
        and(
          eq(notificationDispatch.orgId, orgId),
          eq(notificationDispatch.fingerprint, fingerprint),
          eq(notificationDispatch.contactPointId, contactPointId),
          eq(notificationDispatch.groupKey, groupKey),
        ),
      );
    const row = rows[0];
    return row ? rowToDomain(row) : undefined;
  }

  async upsertSent(input: UpsertDispatchInput): Promise<NotificationDispatchRow> {
    const existing = await this.findByKey(
      input.orgId,
      input.fingerprint,
      input.contactPointId,
      input.groupKey,
    );
    if (existing) {
      const [row] = await this.db
        .update(notificationDispatch)
        .set({ lastSentAt: input.sentAt, sentCount: existing.sentCount + 1 })
        .where(eq(notificationDispatch.id, existing.id))
        .returning();
      return rowToDomain(row!);
    }
    const id = `nd_${randomUUID().slice(0, 12)}`;
    const [row] = await this.db
      .insert(notificationDispatch)
      .values({
        id,
        orgId: input.orgId,
        fingerprint: input.fingerprint,
        contactPointId: input.contactPointId,
        groupKey: input.groupKey,
        lastSentAt: input.sentAt,
        sentCount: 1,
      })
      .returning();
    return rowToDomain(row!);
  }
}
