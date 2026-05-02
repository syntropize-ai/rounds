import type { Change } from '@agentic-obs/common';

export type ChangeSourceType = 'github';

export interface ChangeSource {
  id: string;
  orgId: string;
  type: ChangeSourceType;
  name: string;
  owner: string | null;
  repo: string | null;
  events: string[];
  secret: string | null;
  active: boolean;
  createdAt: string;
  updatedAt: string;
  lastEventAt: string | null;
}

export interface PublicChangeSource extends Omit<ChangeSource, 'secret'> {
  secretMasked: string | null;
}

export interface NewChangeSource {
  id?: string;
  orgId: string;
  type: ChangeSourceType;
  name: string;
  owner?: string | null;
  repo?: string | null;
  events?: string[];
  secret?: string | null;
  active?: boolean;
}

export interface ChangeEvent extends Change {
  orgId: string;
  sourceId: string;
  payload: Record<string, unknown> | null;
  createdAt: string;
}

export interface NewChangeEvent {
  id?: string;
  orgId: string;
  sourceId: string;
  serviceId: string;
  type: Change['type'];
  timestamp: string;
  author: string;
  description: string;
  diff?: string | null;
  version?: string | null;
  payload?: Record<string, unknown> | null;
}

export interface ListChangeEventsOptions {
  orgId: string;
  sourceId?: string;
  serviceId?: string;
  startTime: string;
  endTime: string;
  limit?: number;
}

export interface IChangeSourceRepository {
  listSources(orgId: string, opts?: { masked?: boolean }): Promise<ChangeSource[]>;
  findSourceById(id: string, opts?: { masked?: boolean }): Promise<ChangeSource | null>;
  findSourceByIdInOrg(orgId: string, id: string, opts?: { masked?: boolean }): Promise<ChangeSource | null>;
  createSource(input: NewChangeSource): Promise<ChangeSource>;
  deleteSource(orgId: string, id: string): Promise<boolean>;
  addEvent(input: NewChangeEvent): Promise<ChangeEvent>;
  listEvents(opts: ListChangeEventsOptions): Promise<ChangeEvent[]>;
}
