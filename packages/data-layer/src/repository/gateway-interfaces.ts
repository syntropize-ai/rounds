// Gateway-facing interfaces for dependency injection in the API gateway.
//
// All methods return `MaybeAsync<T>` so async repository implementations
// (SQLite, Postgres, future Redis) satisfy the interface by returning
// Promises. These interfaces are intentionally a subset of the full
// repository surface — the API gateway only needs the operations exposed
// here. Per ADR-001, the canonical implementations live in
// `repository/sqlite/*` and `repository/postgres/*`; in-memory `*Store`
// classes have been retired (Sprint 4).

import type {
  Investigation,
  InvestigationStatus,
  Hypothesis,
  Evidence,
  Incident,
  IncidentTimelineEntry,
  IDashboardRepository,
} from '@agentic-obs/common';
import type { ExplanationResult } from '@agentic-obs/common';
import type {
  FeedItem,
  FeedPage,
  FeedListOptions,
  FeedEventType,
  FeedSeverity,
  FeedFeedback,
  HypothesisFeedback,
  ActionFeedback,
  FeedbackStats,
  FeedTenantOptions,
} from './types/feed.js';
import type {
  FollowUpRecord,
  FeedbackBody,
  StoredFeedback,
} from './types/investigation.js';
import type {
  CreateIncidentParamsWithTenant,
  UpdateIncidentParams,
} from './types/incident.js';
import type { ApprovalRequest } from './types.js';
import type { ShareLink, SharePermission } from './types/share.js';

export type MaybeAsync<T> = T | Promise<T>;

// -- Investigation

export interface IGatewayInvestigationStore {
  // HTTP CRUD
  create(params: {
    question: string;
    sessionId: string;
    userId: string;
    entity?: string;
    timeRange?: { start: string; end: string };
    tenantId?: string;
    workspaceId?: string;
  }): MaybeAsync<Investigation>;
  findById(id: string): MaybeAsync<Investigation | null | undefined>;
  findAll(): MaybeAsync<Investigation[]>;
  getArchived(): MaybeAsync<Investigation[]>;
  restoreFromArchive(id: string): MaybeAsync<Investigation | null | undefined>;
  restoreFromArchiveInWorkspace(id: string, workspaceId: string): MaybeAsync<Investigation | null | undefined>;
  addFollowUp(investigationId: string, question: string): MaybeAsync<FollowUpRecord>;
  addFeedback(investigationId: string, body: FeedbackBody): MaybeAsync<StoredFeedback>;
  getConclusion(id: string): MaybeAsync<ExplanationResult | null | undefined>;

  // Delete
  delete(id: string): MaybeAsync<boolean>;

  // Orchestrator write-back
  updateStatus(id: string, status: InvestigationStatus): MaybeAsync<Investigation | null | undefined>;
  updatePlan(id: string, plan: Investigation['plan']): MaybeAsync<Investigation | null | undefined>;
  updateResult(id: string, result: {
    hypotheses: Hypothesis[];
    evidence: Evidence[];
    conclusion: ExplanationResult | null;
  }): MaybeAsync<Investigation | null | undefined>;
}

// -- Incident

export interface IGatewayIncidentStore {
  create(params: CreateIncidentParamsWithTenant): MaybeAsync<Incident>;
  findById(id: string): MaybeAsync<Incident | undefined>;
  findAll(): MaybeAsync<Incident[]>;
  getArchived(): MaybeAsync<Incident[]>;
  restoreFromArchive(id: string): MaybeAsync<Incident | undefined>;
  update(id: string, params: UpdateIncidentParams): MaybeAsync<Incident | undefined>;
  addInvestigation(incidentId: string, investigationId: string): MaybeAsync<Incident | undefined>;
  getTimeline(incidentId: string): MaybeAsync<IncidentTimelineEntry[] | undefined>;
}

// -- Feed

export interface IGatewayFeedStore {
  // HTTP read/update
  list(options?: FeedListOptions): MaybeAsync<FeedPage>;
  get(id: string, options?: FeedTenantOptions): MaybeAsync<FeedItem | undefined>;
  markRead(id: string, options?: FeedTenantOptions): MaybeAsync<FeedItem | undefined>;
  markFollowedUp(id: string, options?: FeedTenantOptions): MaybeAsync<FeedItem | undefined>;
  addFeedback(id: string, feedback: FeedFeedback, comment?: string, options?: FeedTenantOptions): MaybeAsync<FeedItem | undefined>;
  addHypothesisFeedback(id: string, feedback: HypothesisFeedback, options?: FeedTenantOptions): MaybeAsync<FeedItem | undefined>;
  addActionFeedback(id: string, feedback: ActionFeedback, options?: FeedTenantOptions): MaybeAsync<FeedItem | undefined>;
  getUnreadCount(options?: FeedTenantOptions): MaybeAsync<number>;
  getStats(options?: FeedTenantOptions): MaybeAsync<FeedbackStats>;
  /** Subscribe to new feed items; returns an unsubscribe function. Always sync. */
  subscribe(fn: (item: FeedItem) => void, options?: FeedTenantOptions): () => void;

  // Write - used by orchestrator and proactive pipeline
  add(
    type: FeedEventType,
    title: string,
    summary: string,
    severity: FeedSeverity,
    investigationId?: string,
    tenantId?: string,
  ): MaybeAsync<FeedItem>;
}

// -- Approval

export interface IGatewayApprovalStore {
  findById(id: string): MaybeAsync<ApprovalRequest | undefined>;
  listPending(): MaybeAsync<ApprovalRequest[]>;
  approve(id: string, by: string, roles?: string[]): MaybeAsync<ApprovalRequest | undefined>;
  reject(id: string, by: string, roles?: string[]): MaybeAsync<ApprovalRequest | undefined>;
  override(id: string, by: string, roles?: string[]): MaybeAsync<ApprovalRequest | undefined>;
}

// -- Share

export interface IGatewayShareStore {
  /**
   * Canonical share-token lookup. Distinguishes `expired` from `not_found` so
   * the route layer can return 410 vs 404. Implementations MUST emit a
   * structured warn on expiry detection.
   */
  findByTokenStatus(token: string): MaybeAsync<
    | { kind: 'ok'; link: ShareLink }
    | { kind: 'expired' }
    | { kind: 'not_found' }
  >;
  findByInvestigation(investigationId: string): MaybeAsync<ShareLink[]>;
  revoke(token: string): MaybeAsync<boolean>;
  create(params: {
    investigationId: string;
    createdBy: string;
    permission?: SharePermission;
    expiresInMs?: number;
  }): MaybeAsync<ShareLink>;
}

// -- Dashboard
//
// Per ADR-001 M4: `IGatewayDashboardStore` is an alias for the canonical
// `IDashboardRepository` from `@agentic-obs/common`. New code should import
// `IDashboardRepository` directly.
export type IGatewayDashboardStore = IDashboardRepository;

// -- Aggregate

export interface GatewayStores {
  investigations: IGatewayInvestigationStore;
  incidents: IGatewayIncidentStore;
  feed: IGatewayFeedStore;
  approvals: IGatewayApprovalStore;
  shares: IGatewayShareStore;
  dashboards: IGatewayDashboardStore;
}
