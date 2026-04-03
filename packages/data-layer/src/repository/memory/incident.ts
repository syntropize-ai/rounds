import { randomUUID } from 'crypto';
import type {
  Incident,
  IncidentTimelineEntry,
  IncidentTimelineEntryType,
} from '@agentic-obs/common';
import type {
  IIncidentRepository,
  IncidentFindAllOptions,
} from '../interfaces.js';

export class InMemoryIncidentRepository implements IIncidentRepository {
  private readonly active = new Map<string, Incident>();
  private readonly archived = new Map<string, Incident>();

  async findById(id: string): Promise<Incident | undefined> {
    return this.active.get(id) ?? this.archived.get(id);
  }

  async findAll(opts: IncidentFindAllOptions = {}): Promise<Incident[]> {
    let items = [...this.active.values()];

    if (opts.tenantId !== undefined) {
      items = items.filter((i) => (i as Incident & { tenantId?: string }).tenantId === opts.tenantId);
    }
    if (opts.status !== undefined) {
      items = items.filter((i) => i.status === opts.status);
    }
    if (opts.offset !== undefined) items = items.slice(opts.offset);
    if (opts.limit !== undefined) items = items.slice(0, opts.limit);
    return items;
  }

  async create(
    data: Omit<Incident, 'id' | 'createdAt'> & { id?: string },
  ): Promise<Incident> {
    const now = new Date().toISOString();
    const incident: Incident = {
      ...data,
      id: data.id ?? `inc_${randomUUID().slice(0, 8)}`,
      createdAt: now,
      updatedAt: data.updatedAt ?? now,
    } as Incident;
    this.active.set(incident.id, incident);
    return incident;
  }

  async update(
    id: string,
    patch: Partial<Omit<Incident, 'id'>>,
  ): Promise<Incident | undefined> {
    const existing = this.active.get(id);
    if (!existing) return undefined;
    const updated: Incident = {
      ...existing,
      ...patch,
      id: existing.id,
      updatedAt: new Date().toISOString(),
    } as Incident;
    this.active.set(id, updated);
    return updated;
  }

  async delete(id: string): Promise<boolean> {
    return this.active.delete(id) || this.archived.delete(id);
  }

  async count(): Promise<number> {
    return this.active.size;
  }

  async addTimelineEntry(
    incidentId: string,
    entry: Omit<IncidentTimelineEntry, 'id' | 'timestamp'> & { type?: IncidentTimelineEntryType },
  ): Promise<IncidentTimelineEntry | undefined> {
    const incident = this.active.get(incidentId);
    if (!incident) return undefined;

    const newEntry: IncidentTimelineEntry = {
      ...entry,
      id: `tle_${randomUUID().slice(0, 8)}`,
      timestamp: new Date().toISOString(),
    } as IncidentTimelineEntry;

    const updated: Incident = {
      ...incident,
      timeline: [...incident.timeline, newEntry],
      updatedAt: new Date().toISOString(),
    } as Incident;

    this.active.set(incidentId, updated);
    return newEntry;
  }

  async findByService(serviceId: string, _tenantId?: string): Promise<Incident[]> {
    return [...this.active.values()].filter((i) => i.serviceIds.includes(serviceId));
  }

  async archive(id: string): Promise<Incident | undefined> {
    const item = this.active.get(id);
    if (!item) return undefined;
    this.active.delete(id);
    const archived: Incident = { ...item, updatedAt: new Date().toISOString() } as Incident;
    this.archived.set(id, archived);
    return archived;
  }

  async restore(id: string): Promise<Incident | undefined> {
    const item = this.archived.get(id);
    if (!item) return undefined;
    this.archived.delete(id);
    const restored: Incident = { ...item, updatedAt: new Date().toISOString() } as Incident;
    this.active.set(id, restored);
    return restored;
  }

  /** Test helper */
  clear(): void {
    this.active.clear();
    this.archived.clear();
  }
}
