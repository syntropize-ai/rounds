import { sql, type SQL } from 'drizzle-orm';
import type { SqliteClient } from '../../db/sqlite-client.js';
import type { IAuditLogRepository, Page } from '@agentic-obs/common';
import type { AuditLogEntry, NewAuditLogEntry, AuditLogQuery, AuditActorType, AuditOutcome } from '@agentic-obs/common';
import { uid, nowIso } from './shared.js';

interface Row {
  id: string;
  timestamp: string;
  action: string;
  actor_type: string;
  actor_id: string | null;
  actor_name: string | null;
  org_id: string | null;
  target_type: string | null;
  target_id: string | null;
  target_name: string | null;
  outcome: string;
  metadata: string | null;
  ip: string | null;
  user_agent: string | null;
}

function rowTo(r: Row): AuditLogEntry {
  return {
    id: r.id,
    timestamp: r.timestamp,
    action: r.action,
    actorType: r.actor_type as AuditActorType,
    actorId: r.actor_id,
    actorName: r.actor_name,
    orgId: r.org_id,
    targetType: r.target_type,
    targetId: r.target_id,
    targetName: r.target_name,
    outcome: r.outcome as AuditOutcome,
    metadata: r.metadata,
    ip: r.ip,
    userAgent: r.user_agent,
  };
}

function serializeMetadata(m: unknown): string | null {
  if (m === undefined || m === null) return null;
  if (typeof m === 'string') return m;
  try {
    return JSON.stringify(m);
  } catch {
    return String(m);
  }
}

export class AuditLogRepository implements IAuditLogRepository {
  constructor(private readonly db: SqliteClient) {}

  async log(entry: NewAuditLogEntry): Promise<AuditLogEntry> {
    const id = entry.id ?? uid();
    const timestamp = entry.timestamp ?? nowIso();
    this.db.run(sql`
      INSERT INTO audit_log (
        id, timestamp, action, actor_type, actor_id, actor_name,
        org_id, target_type, target_id, target_name,
        outcome, metadata, ip, user_agent
      ) VALUES (
        ${id}, ${timestamp}, ${entry.action}, ${entry.actorType},
        ${entry.actorId ?? null}, ${entry.actorName ?? null},
        ${entry.orgId ?? null},
        ${entry.targetType ?? null}, ${entry.targetId ?? null},
        ${entry.targetName ?? null},
        ${entry.outcome},
        ${serializeMetadata(entry.metadata)},
        ${entry.ip ?? null}, ${entry.userAgent ?? null}
      )
    `);
    const rows = this.db.all<Row>(sql`SELECT * FROM audit_log WHERE id = ${id}`);
    if (!rows[0]) throw new Error(`[AuditLogRepository] log failed for id=${id}`);
    return rowTo(rows[0]);
  }

  async findById(id: string): Promise<AuditLogEntry | null> {
    const rows = this.db.all<Row>(sql`SELECT * FROM audit_log WHERE id = ${id}`);
    return rows[0] ? rowTo(rows[0]) : null;
  }

  async query(opts: AuditLogQuery = {}): Promise<Page<AuditLogEntry>> {
    const limit = opts.limit ?? 100;
    const offset = opts.offset ?? 0;
    const wheres: SQL[] = [];
    if (opts.actorId) wheres.push(sql`actor_id = ${opts.actorId}`);
    if (opts.targetId) wheres.push(sql`target_id = ${opts.targetId}`);
    if (opts.action) wheres.push(sql`action = ${opts.action}`);
    if (opts.orgId) wheres.push(sql`org_id = ${opts.orgId}`);
    if (opts.outcome) wheres.push(sql`outcome = ${opts.outcome}`);
    if (opts.from) wheres.push(sql`timestamp >= ${opts.from}`);
    if (opts.to) wheres.push(sql`timestamp <= ${opts.to}`);

    const whereClause = wheres.length
      ? sql.join([sql`WHERE`, sql.join(wheres, sql` AND `)], sql` `)
      : sql``;

    const rows = this.db.all<Row>(sql`
      SELECT * FROM audit_log ${whereClause}
      ORDER BY timestamp DESC
      LIMIT ${limit} OFFSET ${offset}
    `);
    const totalRows = this.db.all<{ n: number }>(sql`
      SELECT COUNT(*) AS n FROM audit_log ${whereClause}
    `);
    return { items: rows.map(rowTo), total: totalRows[0]?.n ?? 0 };
  }

  async deleteOlderThan(before: string): Promise<number> {
    const cnt = this.db.all<{ n: number }>(
      sql`SELECT COUNT(*) AS n FROM audit_log WHERE timestamp < ${before}`,
    );
    this.db.run(sql`DELETE FROM audit_log WHERE timestamp < ${before}`);
    return cnt[0]?.n ?? 0;
  }
}
