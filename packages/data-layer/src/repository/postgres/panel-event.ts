/**
 * Postgres-backed `panel_events` repository. Mirrors
 * `../sqlite/panel-event.ts`.
 */

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import type { DbClient } from '../../db/client.js';
import type {
  AggregateBySignatureOptions,
  IPanelEventRepository,
  PanelEvent,
  PanelEventAggregateRow,
  PanelEventType,
} from '../types/panel-event.js';

interface Row {
  id: string;
  org_id: string;
  dashboard_id: string;
  panel_id: string;
  event_type: string;
  panel_snapshot: string;
  query_signature: string | null;
  viz_type: string | null;
  ai_generated: number;
  actor_id: string | null;
  session_id: string | null;
  created_at: string;
}

function rowTo(r: Row): PanelEvent {
  let snapshot: unknown = null;
  try {
    snapshot = JSON.parse(r.panel_snapshot);
  } catch {
    snapshot = r.panel_snapshot;
  }
  return {
    id: r.id,
    orgId: r.org_id,
    dashboardId: r.dashboard_id,
    panelId: r.panel_id,
    eventType: r.event_type as PanelEventType,
    panelSnapshot: snapshot,
    querySignature: r.query_signature,
    vizType: r.viz_type,
    aiGenerated: Number(r.ai_generated) === 1,
    actorId: r.actor_id,
    sessionId: r.session_id,
    createdAt: r.created_at,
  };
}

export class PostgresPanelEventRepository implements IPanelEventRepository {
  constructor(private readonly db: DbClient) {}

  async record(input: Omit<PanelEvent, 'id' | 'createdAt'>): Promise<{ id: string }> {
    const id = randomUUID();
    const createdAt = new Date().toISOString();
    await this.db.run(sql`
      INSERT INTO panel_events (
        id, org_id, dashboard_id, panel_id, event_type,
        panel_snapshot, query_signature, viz_type, ai_generated,
        actor_id, session_id, created_at
      ) VALUES (
        ${id},
        ${input.orgId},
        ${input.dashboardId},
        ${input.panelId},
        ${input.eventType},
        ${JSON.stringify(input.panelSnapshot ?? null)},
        ${input.querySignature ?? null},
        ${input.vizType ?? null},
        ${input.aiGenerated ? 1 : 0},
        ${input.actorId ?? null},
        ${input.sessionId ?? null},
        ${createdAt}
      )
    `);
    return { id };
  }

  async findByDashboard(orgId: string, dashboardId: string, limit = 100): Promise<PanelEvent[]> {
    const rows = await this.db.all<Row>(sql`
      SELECT * FROM panel_events
      WHERE org_id = ${orgId} AND dashboard_id = ${dashboardId}
      ORDER BY created_at DESC
      LIMIT ${limit}
    `);
    return rows.map(rowTo);
  }

  async findByQuerySignature(orgId: string, sig: string, limit = 100): Promise<PanelEvent[]> {
    const rows = await this.db.all<Row>(sql`
      SELECT * FROM panel_events
      WHERE org_id = ${orgId} AND query_signature = ${sig}
      ORDER BY created_at DESC
      LIMIT ${limit}
    `);
    return rows.map(rowTo);
  }

  async aggregateBySignature(
    orgId: string,
    opts: AggregateBySignatureOptions,
  ): Promise<PanelEventAggregateRow[]> {
    const conds: ReturnType<typeof sql>[] = [sql`org_id = ${orgId}`, sql`query_signature IS NOT NULL`];
    if (opts.since) {
      conds.push(sql`created_at >= ${opts.since}`);
    }
    if (opts.eventTypes && opts.eventTypes.length > 0) {
      const typeList = sql.join(
        opts.eventTypes.map((t) => sql`${t}`),
        sql`, `,
      );
      conds.push(sql`event_type IN (${typeList})`);
    }
    const where = sql.join(conds, sql` AND `);

    // Postgres equivalent of the SQLite julianday() diff: cast text timestamps
    // back to TIMESTAMP and compare with INTERVAL '24 hours'.
    const rows = await this.db.all<{
      signature: string;
      viz_type: string | null;
      count: number | string;
      deleted_within_24h: number | string | null;
    }>(sql`
      SELECT
        query_signature AS signature,
        MAX(viz_type) AS viz_type,
        COUNT(*)::int AS count,
        SUM(
          CASE
            WHEN event_type = 'deleted' AND EXISTS (
              SELECT 1 FROM panel_events c
              WHERE c.org_id = panel_events.org_id
                AND c.panel_id = panel_events.panel_id
                AND c.event_type = 'created'
                AND (panel_events.created_at::timestamp - c.created_at::timestamp) <= INTERVAL '24 hours'
            ) THEN 1
            ELSE 0
          END
        )::int AS deleted_within_24h
      FROM panel_events
      WHERE ${where}
      GROUP BY query_signature
      ORDER BY count DESC
    `);
    return rows.map((r) => ({
      signature: r.signature,
      vizType: r.viz_type,
      count: Number(r.count),
      deletedWithin24h: Number(r.deleted_within_24h ?? 0),
    }));
  }
}
