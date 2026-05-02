import { sql } from 'drizzle-orm';
import type { SqliteClient } from '../../db/sqlite-client.js';
import { decryptSecret, encryptSecret, maskSecret, nowIso, uid } from './instance-shared.js';
import type {
  ChangeEvent,
  ChangeSource,
  IChangeSourceRepository,
  ListChangeEventsOptions,
  NewChangeEvent,
  NewChangeSource,
} from '../types/change-source.js';

interface ChangeSourceRow {
  id: string;
  org_id: string;
  type: string;
  name: string;
  owner: string | null;
  repo: string | null;
  events_json: string;
  encrypted_secret: string | null;
  active: number;
  created_at: string;
  updated_at: string;
  last_event_at: string | null;
}

interface ChangeEventRow {
  id: string;
  org_id: string;
  source_id: string;
  service_id: string;
  type: ChangeEvent['type'];
  timestamp: string;
  author: string;
  description: string;
  diff: string | null;
  version: string | null;
  payload_json: string | null;
  created_at: string;
}

function parseJson<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback;
  return JSON.parse(raw) as T;
}

function sourceFromRow(row: ChangeSourceRow, opts: { masked?: boolean } = {}): ChangeSource {
  const secret = decryptSecret(row.encrypted_secret);
  return {
    id: row.id,
    orgId: row.org_id,
    type: 'github',
    name: row.name,
    owner: row.owner,
    repo: row.repo,
    events: parseJson<string[]>(row.events_json, []),
    secret: opts.masked ? maskSecret(secret) : secret,
    active: Boolean(row.active),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastEventAt: row.last_event_at,
  };
}

function eventFromRow(row: ChangeEventRow): ChangeEvent {
  return {
    id: row.id,
    orgId: row.org_id,
    sourceId: row.source_id,
    serviceId: row.service_id,
    type: row.type,
    timestamp: row.timestamp,
    author: row.author,
    description: row.description,
    diff: row.diff ?? undefined,
    version: row.version ?? undefined,
    payload: parseJson<Record<string, unknown> | null>(row.payload_json, null),
    createdAt: row.created_at,
  };
}

export class SqliteChangeSourceRepository implements IChangeSourceRepository {
  constructor(private readonly db: SqliteClient) {}

  async listSources(orgId: string, opts: { masked?: boolean } = {}): Promise<ChangeSource[]> {
    const rows = this.db.all<ChangeSourceRow>(sql`
      SELECT * FROM change_sources
      WHERE org_id = ${orgId}
      ORDER BY name
    `);
    return rows.map((row) => sourceFromRow(row, opts));
  }

  async findSourceById(id: string, opts: { masked?: boolean } = {}): Promise<ChangeSource | null> {
    const rows = this.db.all<ChangeSourceRow>(sql`
      SELECT * FROM change_sources
      WHERE id = ${id}
    `);
    return rows[0] ? sourceFromRow(rows[0], opts) : null;
  }

  async findSourceByIdInOrg(orgId: string, id: string, opts: { masked?: boolean } = {}): Promise<ChangeSource | null> {
    const rows = this.db.all<ChangeSourceRow>(sql`
      SELECT * FROM change_sources
      WHERE org_id = ${orgId} AND id = ${id}
    `);
    return rows[0] ? sourceFromRow(rows[0], opts) : null;
  }

  async createSource(input: NewChangeSource): Promise<ChangeSource> {
    const id = input.id ?? `gh_${uid()}`;
    const now = nowIso();
    this.db.run(sql`
      INSERT INTO change_sources (
        id, org_id, type, name, owner, repo, events_json, encrypted_secret,
        active, created_at, updated_at, last_event_at
      ) VALUES (
        ${id},
        ${input.orgId},
        ${input.type},
        ${input.name},
        ${input.owner ?? null},
        ${input.repo ?? null},
        ${JSON.stringify(input.events ?? [])},
        ${encryptSecret(input.secret ?? null)},
        ${input.active ?? true ? 1 : 0},
        ${now},
        ${now},
        ${null}
      )
    `);
    const saved = await this.findSourceByIdInOrg(input.orgId, id);
    if (!saved) throw new Error(`[ChangeSourceRepository] create: row ${id} not found after insert`);
    return saved;
  }

  async deleteSource(orgId: string, id: string): Promise<boolean> {
    const existing = await this.findSourceByIdInOrg(orgId, id);
    if (!existing) return false;
    this.db.run(sql`DELETE FROM change_sources WHERE org_id = ${orgId} AND id = ${id}`);
    return true;
  }

  async addEvent(input: NewChangeEvent): Promise<ChangeEvent> {
    const id = input.id ?? `chg_${uid()}`;
    const now = nowIso();
    this.db.run(sql`
      INSERT INTO change_events (
        id, org_id, source_id, service_id, type, timestamp, author, description,
        diff, version, payload_json, created_at
      ) VALUES (
        ${id},
        ${input.orgId},
        ${input.sourceId},
        ${input.serviceId},
        ${input.type},
        ${input.timestamp},
        ${input.author},
        ${input.description},
        ${input.diff ?? null},
        ${input.version ?? null},
        ${input.payload ? JSON.stringify(input.payload) : null},
        ${now}
      )
    `);
    this.db.run(sql`
      UPDATE change_sources
      SET last_event_at = ${now}, updated_at = ${now}
      WHERE org_id = ${input.orgId} AND id = ${input.sourceId}
    `);
    const rows = this.db.all<ChangeEventRow>(sql`
      SELECT * FROM change_events WHERE id = ${id}
    `);
    if (!rows[0]) throw new Error(`[ChangeSourceRepository] addEvent: row ${id} not found after insert`);
    return eventFromRow(rows[0]);
  }

  async listEvents(opts: ListChangeEventsOptions): Promise<ChangeEvent[]> {
    const limit = opts.limit ?? 100;
    const rows = this.db.all<ChangeEventRow>(sql`
      SELECT * FROM change_events
      WHERE org_id = ${opts.orgId}
        AND timestamp >= ${opts.startTime}
        AND timestamp <= ${opts.endTime}
        AND (${opts.sourceId ?? null} IS NULL OR source_id = ${opts.sourceId ?? null})
        AND (${opts.serviceId ?? null} IS NULL OR service_id = ${opts.serviceId ?? null})
      ORDER BY timestamp DESC
      LIMIT ${limit}
    `);
    return rows.map(eventFromRow);
  }
}
