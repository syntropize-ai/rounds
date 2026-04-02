import { eq, isNull, and } from 'drizzle-orm';
import { randomUUID } from 'crypto';
import type {
  Incident,
  IncidentTimelineEntry,
  IncidentTimelineEntryType,
} from '@agentic-obs/common';
import type { DbClient } from '../../db/client.js';
import { incidents, incidentTimeline } from '../../db/schema.js';
import type { IIncidentRepository, IncidentFindAllOptions } from '../interfaces.js';

type IncidentRow = typeof incidents.$inferSelect;
type TimelineRow = typeof incidentTimeline.$inferSelect;

function rowToTimelineEntry(row: TimelineRow): IncidentTimelineEntry {
  return {
    id: row.id,
    timestamp: row.timestamp.toISOString(),
    type: row.type as IncidentTimelineEntry['type'],
    description: row.description,
    actorType: (row.actorType ?? 'system') as 'system' | 'human',
    actorId: row.actorId ?? '',
    referenceId: row.referenceId ?? undefined,
    data: (row.metadata ?? undefined) as Record<string, unknown> | undefined,
  };
}

function rowToIncident(row: IncidentRow, timeline: TimelineRow[] = []): Incident {
  return {
    id: row.id,
    title: row.title,
    severity: row.severity as Incident['severity'],
    status: row.status as Incident['status'],
    services: (row.services as string[]) ?? [],
    investigationIds: [],
    timeline: timeline.map(rowToTimelineEntry),
    assignee: row.assignee ?? undefined,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    resolvedAt: undefined,
  };
}

export class PostgresIncidentRepository implements IIncidentRepository {
  constructor(private readonly db: DbClient) {}

  async findById(id: string): Promise<Incident | undefined> {
    const [row] = await this.db.select().from(incidents).where(eq(incidents.id, id));
    if (!row) return undefined;
    const timeline = await this.db
      .select()
      .from(incidentTimeline)
      .where(eq(incidentTimeline.incidentId, id));
    return rowToIncident(row, timeline);
  }

  async findAll(opts: IncidentFindAllOptions = {}): Promise<Incident[]> {
    const conditions = [isNull(incidents.archivedAt)];
    if (opts.tenantId) conditions.push(eq(incidents.tenantId, opts.tenantId));
    if (opts.status) conditions.push(eq(incidents.status, opts.status));

    const rows = await this.db
      .select()
      .from(incidents)
      .where(and(...conditions))
      .limit(opts.limit ?? 100)
      .offset(opts.offset ?? 0);
    return rows.map((r) => rowToIncident(r));
  }

  async create(data: Omit<Incident, 'id' | 'createdAt'> & { id?: string }): Promise<Incident> {
    const now = new Date();
    const id = data.id ?? `inc_${randomUUID().slice(0, 8)}`;
    const tenantId = (data as Incident & { tenantId?: string }).tenantId ?? 'default';
    const [row] = await this.db
      .insert(incidents)
      .values({
        id,
        tenantId,
        title: data.title,
        severity: data.severity,
        status: data.status,
        services: data.services,
        assignee: data.assignee,
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    return rowToIncident(row);
  }

  async update(id: string, patch: Partial<Omit<Incident, 'id'>>): Promise<Incident | undefined> {
    const [row] = await this.db
      .update(incidents)
      .set({
        ...(patch.title !== undefined ? { title: patch.title } : {}),
        ...(patch.status !== undefined ? { status: patch.status } : {}),
        ...(patch.severity !== undefined ? { severity: patch.severity } : {}),
        ...(patch.services !== undefined ? { services: patch.services } : {}),
        ...(patch.assignee !== undefined ? { assignee: patch.assignee } : {}),
        updatedAt: new Date(),
      })
      .where(eq(incidents.id, id))
      .returning();
    return row ? rowToIncident(row) : undefined;
  }

  async delete(id: string): Promise<boolean> {
    const result = await this.db.delete(incidents).where(eq(incidents.id, id));
    return (result.rowCount ?? 0) > 0;
  }

  async count(): Promise<number> {
    const rows = await this.db.select().from(incidents).where(isNull(incidents.archivedAt));
    return rows.length;
  }

  async addTimelineEntry(
    incidentId: string,
    entry: Omit<IncidentTimelineEntry, 'id' | 'timestamp'> & { type?: IncidentTimelineEntryType },
  ): Promise<IncidentTimelineEntry | undefined> {
    const existing = await this.db.select().from(incidents).where(eq(incidents.id, incidentId));
    if (!existing.length) return undefined;
    const [row] = await this.db
      .insert(incidentTimeline)
      .values({
        id: `tle_${randomUUID().slice(0, 8)}`,
        incidentId,
        type: entry.type,
        description: entry.description,
        actorType: entry.actorType,
        actorId: entry.actorId,
        referenceId: entry.referenceId,
        metadata: entry.data as Record<string, unknown> | undefined,
        timestamp: new Date(),
      })
      .returning();
    return row ? rowToTimelineEntry(row) : undefined;
  }

  async findByService(serviceId: string, tenantId?: string): Promise<Incident[]> {
    const rows = await this.db.select().from(incidents).where(isNull(incidents.archivedAt));
    return rows
      .filter((r) => {
        const svcs = r.services as string[];
        return svcs.includes(serviceId) && (tenantId === undefined || r.tenantId === tenantId);
      })
      .map((r) => rowToIncident(r));
  }

  async archive(id: string): Promise<Incident | undefined> {
    const [row] = await this.db
      .update(incidents)
      .set({ archivedAt: new Date(), updatedAt: new Date() })
      .where(eq(incidents.id, id))
      .returning();
    return row ? rowToIncident(row) : undefined;
  }

  async restore(id: string): Promise<Incident | undefined> {
    const [row] = await this.db
      .update(incidents)
      .set({ archivedAt: null, updatedAt: new Date() })
      .where(eq(incidents.id, id))
      .returning();
    return row ? rowToIncident(row) : undefined;
  }
}
