/**
 * In-memory implementation of `IDashboardVariableAckRepository`
 * (Wave 2 / Step 4). Test fixture only — production wiring uses the
 * SQLite or Postgres repository.
 */

import { randomUUID } from 'node:crypto';
import type {
  DashboardVariableAck,
  IDashboardVariableAckRepository,
} from '@agentic-obs/common';

function key(userId: string, dashboardUid: string, varsHash: string): string {
  return `${userId}|${dashboardUid}|${varsHash}`;
}

export class InMemoryDashboardVariableAckRepository
  implements IDashboardVariableAckRepository
{
  private readonly rows = new Map<string, DashboardVariableAck>();

  async findAck(
    userId: string,
    dashboardUid: string,
    varsHash: string,
  ): Promise<DashboardVariableAck | null> {
    return this.rows.get(key(userId, dashboardUid, varsHash)) ?? null;
  }

  async ackVariables(input: {
    orgId: string;
    userId: string;
    dashboardUid: string;
    varsHash: string;
  }): Promise<DashboardVariableAck> {
    const k = key(input.userId, input.dashboardUid, input.varsHash);
    const existing = this.rows.get(k);
    if (existing) return existing;
    const row: DashboardVariableAck = {
      id: randomUUID(),
      orgId: input.orgId,
      userId: input.userId,
      dashboardUid: input.dashboardUid,
      varsHash: input.varsHash,
      ackedAt: new Date().toISOString(),
    };
    this.rows.set(k, row);
    return row;
  }

  async clearAcksForDashboard(dashboardUid: string): Promise<void> {
    for (const [k, row] of this.rows.entries()) {
      if (row.dashboardUid === dashboardUid) this.rows.delete(k);
    }
  }
}
