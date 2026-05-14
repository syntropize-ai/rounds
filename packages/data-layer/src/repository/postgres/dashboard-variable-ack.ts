/**
 * Postgres implementation of `IDashboardVariableAckRepository`
 * (Wave 2 / Step 4). Mirror of the SQLite implementation.
 */

import { and, eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import type {
  DashboardVariableAck,
  IDashboardVariableAckRepository,
} from '@agentic-obs/common';
import { dashboardVariableAck } from './schema.js';

type Row = typeof dashboardVariableAck.$inferSelect;

function rowToAck(row: Row): DashboardVariableAck {
  return {
    id: row.id,
    orgId: row.orgId,
    userId: row.userId,
    dashboardUid: row.dashboardUid,
    varsHash: row.varsHash,
    ackedAt: row.ackedAt,
  };
}

export class PostgresDashboardVariableAckRepository
  implements IDashboardVariableAckRepository
{
  constructor(private readonly db: any) {}

  async findAck(
    userId: string,
    dashboardUid: string,
    varsHash: string,
  ): Promise<DashboardVariableAck | null> {
    const [row] = await this.db
      .select()
      .from(dashboardVariableAck)
      .where(
        and(
          eq(dashboardVariableAck.userId, userId),
          eq(dashboardVariableAck.dashboardUid, dashboardUid),
          eq(dashboardVariableAck.varsHash, varsHash),
        ),
      );
    return row ? rowToAck(row) : null;
  }

  async ackVariables(input: {
    orgId: string;
    userId: string;
    dashboardUid: string;
    varsHash: string;
  }): Promise<DashboardVariableAck> {
    const existing = await this.findAck(
      input.userId,
      input.dashboardUid,
      input.varsHash,
    );
    if (existing) return existing;
    const row: Row = {
      id: randomUUID(),
      orgId: input.orgId,
      userId: input.userId,
      dashboardUid: input.dashboardUid,
      varsHash: input.varsHash,
      ackedAt: new Date().toISOString(),
    };
    await this.db.insert(dashboardVariableAck).values(row).onConflictDoNothing();
    const fresh = await this.findAck(
      input.userId,
      input.dashboardUid,
      input.varsHash,
    );
    return fresh ?? rowToAck(row);
  }

  async clearAcksForDashboard(dashboardUid: string): Promise<void> {
    await this.db
      .delete(dashboardVariableAck)
      .where(eq(dashboardVariableAck.dashboardUid, dashboardUid));
  }
}
