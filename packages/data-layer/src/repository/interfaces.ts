import type {
  Investigation,
  Incident,
  IncidentTimelineEntry,
  IncidentTimelineEntryType,
} from '@agentic-obs/common';
import type { FeedEvent, Case, ApprovalRecord, ShareLink } from './types.js';

// — Base

export interface FindAllOptions<T> {
  filter?: Partial<T>;
  limit?: number;
  offset?: number;
}

export interface IRepository<T extends { id: string }> {
  findById(id: string): Promise<T | undefined>;
  findAll(opts?: FindAllOptions<T>): Promise<T[]>;
  create(entity: Omit<T, 'id' | 'createdAt'> & { id?: string }): Promise<T>;
  update(id: string, patch: Partial<Omit<T, 'id'>>): Promise<T | undefined>;
  delete(id: string): Promise<boolean>;
  count(): Promise<number>;
}

// — Investigation

export interface InvestigationFindAllOptions extends FindAllOptions<Investigation> {
  tenantId?: string;
  status?: string;
}

export interface IInvestigationRepository extends IRepository<Investigation> {
  findAll(opts?: InvestigationFindAllOptions): Promise<Investigation[]>;
  findBySession(sessionId: string): Promise<Investigation[]>;
  findByUser(userId: string, tenantId?: string): Promise<Investigation[]>;
  archive(id: string): Promise<Investigation | undefined>;
  restore(id: string): Promise<Investigation | undefined>;
  findArchived(tenantId?: string): Promise<Investigation[]>;
}

// — Incident

export interface IncidentFindAllOptions extends FindAllOptions<Incident> {
  tenantId?: string;
  status?: string;
}

export interface IIncidentRepository extends IRepository<Incident> {
  findAll(opts?: IncidentFindAllOptions): Promise<Incident[]>;
  addTimelineEntry(
    incidentId: string,
    entry: Omit<IncidentTimelineEntry, 'id' | 'timestamp'> & {
      type?: IncidentTimelineEntryType;
    },
  ): Promise<IncidentTimelineEntry | undefined>;
  findByService(serviceId: string, tenantId?: string): Promise<Incident[]>;
  archive(id: string): Promise<Incident | undefined>;
  restore(id: string): Promise<Incident | undefined>;
}

// — Feed

export interface FeedFindAllOptions extends FindAllOptions<FeedEvent> {
  tenantId?: string;
}

export interface IFeedRepository extends IRepository<FeedEvent> {
  findAll(opts?: FeedFindAllOptions): Promise<FeedEvent[]>;
  add(event: Omit<FeedEvent, 'id' | 'createdAt'>): Promise<FeedEvent>;
  findByType(type: string, tenantId?: string): Promise<FeedEvent[]>;
  findBySeverity(severity: string, tenantId?: string): Promise<FeedEvent[]>;
}

// — Approval

export interface IApprovalRepository extends IRepository<ApprovalRecord> {
  submit(data: Omit<ApprovalRecord, 'id' | 'createdAt'>): Promise<ApprovalRecord>;
  listPending(tenantId?: string): Promise<ApprovalRecord[]>;
  approve(id: string, by: string, roles?: string[]): Promise<ApprovalRecord | undefined>;
  reject(id: string, by: string, roles?: string[]): Promise<ApprovalRecord | undefined>;
  override(id: string, by: string, roles?: string[]): Promise<ApprovalRecord | undefined>;
}

// — ShareLink

export interface IShareRepository extends IRepository<ShareLink> {
  findByToken(token: string): Promise<ShareLink | undefined>;
  findByInvestigation(investigationId: string): Promise<ShareLink[]>;
  revoke(token: string): Promise<boolean>;
}

// — Case

export interface CaseFindAllOptions extends FindAllOptions<Case> {
  tenantId?: string;
}

export interface ICaseRepository extends IRepository<Case> {
  findAll(opts?: CaseFindAllOptions): Promise<Case[]>;
  search(query: string, limit?: number, tenantId?: string): Promise<Case[]>;
  findByService(serviceId: string, tenantId?: string): Promise<Case[]>;
}
