import { randomUUID } from 'crypto';
import type {
  Incident,
  IncidentStatus,
  IncidentSeverity,
  IncidentTimelineEntry,
  IncidentTimelineEntryType,
} from '@agentic-obs/common';

export interface CreateIncidentParams {
  title: string;
  severity: IncidentSeverity;
  services?: string[];
  assignee?: string;
}

export interface UpdateIncidentParams {
  title?: string;
  status?: IncidentStatus;
  severity?: IncidentSeverity;
  services?: string[];
  assignee?: string;
}

export interface CreateIncidentParamsWithTenant extends CreateIncidentParams {
  tenantId?: string;
  workspaceId?: string;
}

export class IncidentStore {
  private readonly incidents = new Map<string, Incident>();
  private readonly archivedItems = new Map<string, Incident>();
  private readonly maxCapacity: number;
  private readonly tenants = new Map<string, string>();
  private readonly workspaces = new Map<string, string>();

  constructor(maxCapacity = 500) {
    this.maxCapacity = maxCapacity;
  }

  create(params: CreateIncidentParamsWithTenant): Incident {
    const now = new Date().toISOString();
    const id = `inc_${randomUUID().slice(0, 8)}`;
    const incident: Incident = {
      id,
      title: params.title,
      severity: params.severity,
      status: 'open',
      serviceIds: params.services ?? [],
      investigationIds: [],
      timeline: [],
      assignee: params.assignee,
      ...(params.workspaceId ? { workspaceId: params.workspaceId } : {}),
      createdAt: now,
      updatedAt: now,
    };

    this.incidents.set(id, incident);
    if (params.tenantId)
      this.tenants.set(id, params.tenantId);
    if (params.workspaceId)
      this.workspaces.set(id, params.workspaceId);
    this.evictIfNeeded();
    return incident;
  }

  private evictIfNeeded(): void {
    if (this.incidents.size <= this.maxCapacity)
      return;
    let oldest: Incident | undefined;
    for (const inc of this.incidents.values()) {
      if (inc.status === 'resolved') {
        if (!oldest || inc.createdAt < oldest.createdAt)
          oldest = inc;
      }
    }
    if (oldest) {
      this.archivedItems.set(oldest.id, oldest);
      this.incidents.delete(oldest.id);
    }
  }

  findById(id: string): Incident | undefined {
    return this.incidents.get(id) ?? this.archivedItems.get(id);
  }

  getArchived(): Incident[] {
    return [...this.archivedItems.values()];
  }

  restoreFromArchive(id: string): Incident | undefined {
    const inc = this.archivedItems.get(id);
    if (!inc)
      return undefined;
    this.archivedItems.delete(id);
    this.incidents.set(id, inc);
    return inc;
  }

  findAll(tenantId?: string): Incident[] {
    const all = [...this.incidents.values()];
    if (tenantId === undefined)
      return all;
    return all.filter((inc) => this.tenants.get(inc.id) === tenantId);
  }

  findByWorkspace(workspaceId: string): Incident[] {
    return [...this.incidents.values()].filter(
      (inc) => this.workspaces.get(inc.id) === workspaceId,
    );
  }

  getWorkspaceId(id: string): string | undefined {
    return this.workspaces.get(id);
  }

  update(id: string, params: UpdateIncidentParams): Incident | undefined {
    const incident = this.incidents.get(id);
    if (!incident)
      return undefined;

    const now = new Date().toISOString();
    const oldStatus = incident.status;

    const updated: Incident = {
      ...incident,
      title: params.title ?? incident.title,
      status: params.status ?? incident.status,
      severity: params.severity ?? incident.severity,
      serviceIds: params.services ?? incident.serviceIds,
      assignee: params.assignee !== undefined ? params.assignee : incident.assignee,
      updatedAt: now,
      resolvedAt: params.status === 'resolved' && !incident.resolvedAt ? now : incident.resolvedAt,
    };

    // Auto-add timeline entry for status changes
    if (params.status && params.status !== oldStatus) {
      updated.timeline = [
        ...updated.timeline,
        this.createTimelineEntry(
          'status_changed',
          `Status changed from ${oldStatus} to ${params.status}`,
          'system',
          'incident-store',
        ),
      ];
    }

    this.incidents.set(id, updated);
    return updated;
  }

  addInvestigation(incidentId: string, investigationId: string): Incident | undefined {
    const incident = this.incidents.get(incidentId);
    if (!incident)
      return undefined;
    if (incident.investigationIds.includes(investigationId))
      return incident;

    const now = new Date().toISOString();
    const updated: Incident = {
      ...incident,
      investigationIds: [...incident.investigationIds, investigationId],
      timeline: [
        ...incident.timeline,
        this.createTimelineEntry(
          'investigation_created',
          `Investigation ${investigationId} linked to incident`,
          'system',
          'incident-store',
          investigationId,
        ),
      ],
      updatedAt: now,
    };

    this.incidents.set(incidentId, updated);
    return updated;
  }

  addTimelineEntry(
    incidentId: string,
    type: IncidentTimelineEntryType,
    description: string,
    actorType: 'system' | 'human',
    actorId: string,
    referenceId?: string,
    data?: Record<string, unknown>,
  ): IncidentTimelineEntry | undefined {
    const incident = this.incidents.get(incidentId);
    if (!incident)
      return undefined;
    const entry = this.createTimelineEntry(type, description, actorType, actorId, referenceId, data);
    const now = new Date().toISOString();
    this.incidents.set(incidentId, {
      ...incident,
      timeline: [...incident.timeline, entry],
      updatedAt: now,
    });
    return entry;
  }

  getTimeline(incidentId: string): IncidentTimelineEntry[] | undefined {
    const incident = this.incidents.get(incidentId);
    if (!incident)
      return undefined;
    return incident.timeline;
  }

  get size(): number {
    return this.incidents.size;
  }

  clear(): void {
    this.incidents.clear();
    this.archivedItems.clear();
    this.tenants.clear();
    this.workspaces.clear();
  }

  private createTimelineEntry(
    type: IncidentTimelineEntryType,
    description: string,
    actorType: 'system' | 'human',
    actorId: string,
    referenceId?: string,
    data?: Record<string, unknown>,
  ): IncidentTimelineEntry {
    return {
      id: `tle_${randomUUID().slice(0, 8)}`,
      timestamp: new Date().toISOString(),
      type,
      description,
      actorType,
      actorId,
      referenceId,
      data,
    };
  }
}

export const incidentStore = new IncidentStore();
