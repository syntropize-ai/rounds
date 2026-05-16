import type {
  Investigation,
  Incident,
  IncidentTimelineEntry,
  IncidentTimelineEntryType,
  Dashboard,
  DashboardStatus,
  DashboardVariable,
  PanelConfig,
  AlertRule,
  AlertRuleState,
  AlertHistoryEntry,
  AlertSilence,
  NotificationPolicy,
  ContactPoint,
  ContactPointIntegration,
  NotificationPolicyNode,
  MuteTiming,
  TimeInterval,
  AssetType,
  AssetVersion,
  EditSource,
  SavedInvestigationReport,
  PostMortemReport,
  ChatSession,
  ChatSessionContext,
  ChatSessionContextRelation,
  ChatSessionContextResourceType,
  ChatMessage,
} from '@agentic-obs/common';
import type { ExplanationResult } from '@agentic-obs/common';
import type { FeedEvent, Case, ApprovalRecord } from './types.js';
import type { FollowUpRecord, FeedbackBody, StoredFeedback } from './types/investigation.js';
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
import type { ApprovalAction, ApprovalContext, ApprovalRequest, ApprovalStatus } from './types.js';
import type { SharePermission, ShareLink as StoreShareLink } from './types/share.js';
import type { Folder } from './types/folder.js';

// — Utility

export type MaybeAsync<T> = T | Promise<T>;

// — Base

export interface FindAllOptions<T> {
  filter?: Partial<T>;
  limit?: number;
  offset?: number;
}

export interface IRepository<T extends { id: string }> {
  findById(id: string): MaybeAsync<T | undefined>;
  findAll(opts?: FindAllOptions<T>): MaybeAsync<T[]>;
  create(entity: Omit<T, 'id' | 'createdAt'> & { id?: string }): MaybeAsync<T>;
  update(id: string, patch: Partial<Omit<T, 'id'>>): MaybeAsync<T | undefined>;
  delete(id: string): MaybeAsync<boolean>;
  count(): MaybeAsync<number>;
}

// — Investigation

export interface InvestigationFindAllOptions extends FindAllOptions<Investigation> {
  tenantId?: string;
  status?: string;
}

export interface IInvestigationRepository extends IRepository<Investigation> {
  findAll(opts?: InvestigationFindAllOptions): MaybeAsync<Investigation[]>;
  findBySession(sessionId: string): MaybeAsync<Investigation[]>;
  findByUser(userId: string, tenantId?: string): MaybeAsync<Investigation[]>;
  findByWorkspace(workspaceId: string): MaybeAsync<Investigation[]>;
  archive(id: string): MaybeAsync<Investigation | undefined>;
  restore(id: string): MaybeAsync<Investigation | undefined>;
  findArchived(tenantId?: string): MaybeAsync<Investigation[]>;

  // Follow-ups
  addFollowUp(investigationId: string, question: string): MaybeAsync<FollowUpRecord>;
  getFollowUps(investigationId: string): MaybeAsync<FollowUpRecord[]>;

  // Feedback
  addFeedback(investigationId: string, body: FeedbackBody): MaybeAsync<StoredFeedback>;

  // Conclusions
  getConclusion(id: string): MaybeAsync<ExplanationResult | undefined>;
  setConclusion(id: string, conclusion: ExplanationResult): MaybeAsync<void>;

  // Orchestrator write-back
  updateStatus(id: string, status: string): MaybeAsync<Investigation | undefined>;
  updatePlan(id: string, plan: Investigation['plan']): MaybeAsync<Investigation | undefined>;
  updateResult(id: string, result: {
    hypotheses: Investigation['hypotheses'];
    evidence: Investigation['evidence'];
    conclusion: ExplanationResult | null;
  }): MaybeAsync<Investigation | undefined>;
}

// — Incident

export interface IncidentFindAllOptions extends FindAllOptions<Incident> {
  tenantId?: string;
  status?: string;
}

export interface IIncidentRepository extends IRepository<Incident> {
  findAll(opts?: IncidentFindAllOptions): MaybeAsync<Incident[]>;
  addTimelineEntry(
    incidentId: string,
    entry: Omit<IncidentTimelineEntry, 'id' | 'timestamp'> & {
      type?: IncidentTimelineEntryType;
    },
  ): MaybeAsync<IncidentTimelineEntry | undefined>;
  findByService(serviceId: string, tenantId?: string): MaybeAsync<Incident[]>;
  findByWorkspace(workspaceId: string): MaybeAsync<Incident[]>;
  addInvestigation(incidentId: string, investigationId: string): MaybeAsync<Incident | undefined>;
  getTimeline(incidentId: string): MaybeAsync<IncidentTimelineEntry[] | undefined>;
  archive(id: string): MaybeAsync<Incident | undefined>;
  restore(id: string): MaybeAsync<Incident | undefined>;
  findArchived(tenantId?: string): MaybeAsync<Incident[]>;
}

// — Feed

export interface FeedFindAllOptions extends FindAllOptions<FeedEvent> {
  tenantId?: string;
}

export interface IFeedRepository extends IRepository<FeedEvent> {
  findAll(opts?: FeedFindAllOptions): MaybeAsync<FeedEvent[]>;
  add(event: Omit<FeedEvent, 'id' | 'createdAt'>): MaybeAsync<FeedEvent>;
  findByType(type: string, tenantId?: string): MaybeAsync<FeedEvent[]>;
  findBySeverity(severity: string, tenantId?: string): MaybeAsync<FeedEvent[]>;
}

// — FeedItem (rich feed with feedback, distinct from raw FeedEvent)

export interface IFeedItemRepository {
  add(
    type: FeedEventType,
    title: string,
    summary: string,
    severity: FeedSeverity,
    investigationId?: string,
    tenantId?: string,
  ): MaybeAsync<FeedItem>;
  get(id: string, options?: FeedTenantOptions): MaybeAsync<FeedItem | undefined>;
  list(options?: FeedListOptions): MaybeAsync<FeedPage>;
  markRead(id: string, options?: FeedTenantOptions): MaybeAsync<FeedItem | undefined>;
  markFollowedUp(id: string, options?: FeedTenantOptions): MaybeAsync<FeedItem | undefined>;
  addFeedback(id: string, feedback: FeedFeedback, comment?: string, options?: FeedTenantOptions): MaybeAsync<FeedItem | undefined>;
  addHypothesisFeedback(id: string, feedback: HypothesisFeedback, options?: FeedTenantOptions): MaybeAsync<FeedItem | undefined>;
  addActionFeedback(id: string, feedback: ActionFeedback, options?: FeedTenantOptions): MaybeAsync<FeedItem | undefined>;
  getUnreadCount(options?: FeedTenantOptions): MaybeAsync<number>;
  getStats(options?: FeedTenantOptions): MaybeAsync<FeedbackStats>;
}

// — Approval

export interface IApprovalRepository extends IRepository<ApprovalRecord> {
  submit(data: Omit<ApprovalRecord, 'id' | 'createdAt'>): MaybeAsync<ApprovalRecord>;
  listPending(tenantId?: string): MaybeAsync<ApprovalRecord[]>;
  approve(id: string, by: string, roles?: string[]): MaybeAsync<ApprovalRecord | undefined>;
  reject(id: string, by: string, roles?: string[]): MaybeAsync<ApprovalRecord | undefined>;
  override(id: string, by: string, roles?: string[]): MaybeAsync<ApprovalRecord | undefined>;
}

// — Approval (gateway-level, matches ApprovalRequest shape)

/**
 * Per-row scope filter for `IApprovalRequestRepository.list`.
 *
 * `wildcard` → no scope WHERE narrowing (still filters by org_id and optional status).
 * `narrow`   → row matches if any populated set covers it (id ∪ connector ∪ (connector,ns) ∪ team).
 *              Empty `narrow` (no sets) → zero rows; never falls back to org-wide.
 */
export type ApprovalScopeFilter =
  | { kind: 'wildcard' }
  | {
      kind: 'narrow';
      uids?: ReadonlySet<string>;
      connectors?: ReadonlySet<string>;
      nsPairs?: ReadonlyArray<{ connectorId: string; ns: string }>;
      teams?: ReadonlySet<string>;
    };

export interface IApprovalRequestRepository {
  findById(id: string): Promise<ApprovalRequest | undefined>;
  submit(params: {
    action: ApprovalAction;
    context: ApprovalContext;
    ttlMs?: number;
    /** See approvals-multi-team-scope §3.6. NULL when plan has no ops step. */
    opsConnectorId?: string | null;
    /** See approvals-multi-team-scope §3.6. NULL for cluster-scoped plans. */
    targetNamespace?: string | null;
    /** See approvals-multi-team-scope §3.6. NULL when no team-owned folder. */
    requesterTeamId?: string | null;
  }): Promise<ApprovalRequest>;
  listPending(): Promise<ApprovalRequest[]>;
  /**
   * Org-scoped list with optional per-row scope filter and status filter.
   *
   * scopeFilter omitted → no narrowing (full org list).
   * status omitted      → all statuses.
   */
  list(
    orgId: string,
    opts?: { scopeFilter?: ApprovalScopeFilter; status?: ApprovalStatus | ApprovalStatus[] },
  ): Promise<ApprovalRequest[]>;
  approve(id: string, by: string, roles?: string[]): Promise<ApprovalRequest | undefined>;
  reject(id: string, by: string, roles?: string[]): Promise<ApprovalRequest | undefined>;
  override(id: string, by: string, roles?: string[]): Promise<ApprovalRequest | undefined>;
}

// — ShareLink (gateway-level, mirrors the store's ShareLink shape — no `id`)

export type ShareLookupResult =
  | { kind: 'ok'; link: StoreShareLink }
  | { kind: 'expired' }
  | { kind: 'not_found' };

export interface IShareLinkRepository {
  create(params: {
    investigationId: string;
    createdBy: string;
    permission?: SharePermission;
    expiresInMs?: number;
  }): MaybeAsync<StoreShareLink>;
  /**
   * Distinguishes `expired` from `not_found` so the route layer can return a
   * specific 410 / "this link expired" response instead of a generic 404.
   * Implementations MUST emit a structured warn log on expiry detection so
   * operators can correlate failed share visits to expired links, and SHOULD
   * purge the expired record as a side effect.
   */
  findByTokenStatus(token: string): MaybeAsync<ShareLookupResult>;
  findByInvestigation(investigationId: string): MaybeAsync<StoreShareLink[]>;
  revoke(token: string): MaybeAsync<boolean>;
}

// — Case

export interface CaseFindAllOptions extends FindAllOptions<Case> {
  tenantId?: string;
}

export interface ICaseRepository extends IRepository<Case> {
  findAll(opts?: CaseFindAllOptions): MaybeAsync<Case[]>;
  search(query: string, limit?: number, tenantId?: string): MaybeAsync<Case[]>;
  findByService(serviceId: string, tenantId?: string): MaybeAsync<Case[]>;
}

// — Dashboard

export interface IDashboardRepository {
  create(params: {
    title: string;
    description: string;
    prompt: string;
    userId: string;
    datasourceIds: string[];
    useExistingMetrics?: boolean;
    folder?: string;
    workspaceId?: string;
    sessionId?: string;
  }): MaybeAsync<Dashboard>;
  findById(id: string): MaybeAsync<Dashboard | undefined>;
  findAll(userId?: string): MaybeAsync<Dashboard[]>;
  listByWorkspace(workspaceId: string): MaybeAsync<Dashboard[]>;
  update(id: string, patch: Partial<Pick<Dashboard, 'type' | 'title' | 'description' | 'panels' | 'variables' | 'refreshIntervalSec' | 'folder'>>): MaybeAsync<Dashboard | undefined>;
  updateStatus(id: string, status: DashboardStatus, error?: string): MaybeAsync<Dashboard | undefined>;
  updatePanels(id: string, panels: PanelConfig[]): MaybeAsync<Dashboard | undefined>;
  updateVariables(id: string, variables: DashboardVariable[]): MaybeAsync<Dashboard | undefined>;
  delete(id: string): MaybeAsync<boolean>;
  /**
   * Resolve the folder UID for a dashboard within an org. Used by RBAC
   * resolvers to enforce folder-scoped permissions.
   */
  getFolderUid(orgId: string, dashboardId: string): MaybeAsync<string | null>;
}

// — Folder

export interface IFolderRepository {
  create(params: { name: string; parentId?: string }): MaybeAsync<Folder>;
  findAll(): MaybeAsync<Folder[]>;
  findById(id: string): MaybeAsync<Folder | undefined>;
  findByParent(parentId?: string): MaybeAsync<Folder[]>;
  rename(id: string, name: string): MaybeAsync<Folder | undefined>;
  delete(id: string): MaybeAsync<boolean>;
  getPath(id: string): MaybeAsync<string>;
}

// — AlertRule

export interface AlertRuleFindAllOptions {
  state?: AlertRuleState;
  severity?: string;
  search?: string;
  limit?: number;
  offset?: number;
}

export interface IAlertRuleRepository {
  create(data: Omit<AlertRule, 'id' | 'createdAt' | 'updatedAt' | 'fireCount' | 'state' | 'stateChangedAt'>): MaybeAsync<AlertRule>;
  findById(id: string): MaybeAsync<AlertRule | undefined>;
  findAll(filter?: AlertRuleFindAllOptions): MaybeAsync<{ list: AlertRule[]; total: number }>;
  findByWorkspace(workspaceId: string): MaybeAsync<AlertRule[]>;
  update(id: string, patch: Partial<Omit<AlertRule, 'id' | 'createdAt'>>): MaybeAsync<AlertRule | undefined>;
  delete(id: string): MaybeAsync<boolean>;
  transition(id: string, newState: AlertRuleState, value?: number): MaybeAsync<AlertRule | undefined>;

  // History
  getHistory(ruleId: string, limit?: number): MaybeAsync<AlertHistoryEntry[]>;
  getAllHistory(limit?: number): MaybeAsync<AlertHistoryEntry[]>;

  // Silences
  createSilence(data: Omit<AlertSilence, 'id' | 'createdAt'>): MaybeAsync<AlertSilence>;
  findSilences(): MaybeAsync<AlertSilence[]>;
  findAllSilencesIncludingExpired(): MaybeAsync<AlertSilence[]>;
  updateSilence(id: string, patch: Partial<Omit<AlertSilence, 'id' | 'createdAt'>>): MaybeAsync<AlertSilence | undefined>;
  deleteSilence(id: string): MaybeAsync<boolean>;

  // Notification Policies (flat, from AlertRuleStore)
  createPolicy(data: Omit<NotificationPolicy, 'id' | 'createdAt' | 'updatedAt'>): MaybeAsync<NotificationPolicy>;
  findAllPolicies(): MaybeAsync<NotificationPolicy[]>;
  findPolicyById(id: string): MaybeAsync<NotificationPolicy | undefined>;
  updatePolicy(id: string, patch: Partial<Omit<NotificationPolicy, 'id' | 'createdAt'>>): MaybeAsync<NotificationPolicy | undefined>;
  deletePolicy(id: string): MaybeAsync<boolean>;
  /**
   * Resolve the folder UID for an alert rule within an org. Used by RBAC
   * resolvers to enforce folder-scoped permissions.
   */
  getFolderUid(orgId: string, ruleId: string): MaybeAsync<string | null>;
}

// — Notification (contact points, policy tree, mute timings)

export interface INotificationRepository {
  // Contact Points
  createContactPoint(data: { name: string; integrations: ContactPointIntegration[] }): MaybeAsync<ContactPoint>;
  findAllContactPoints(): MaybeAsync<ContactPoint[]>;
  findContactPointById(id: string): MaybeAsync<ContactPoint | undefined>;
  updateContactPoint(id: string, patch: Partial<Omit<ContactPoint, 'id' | 'createdAt'>>): MaybeAsync<ContactPoint | undefined>;
  deleteContactPoint(id: string): MaybeAsync<boolean>;

  // Policy Tree
  getPolicyTree(): MaybeAsync<NotificationPolicyNode>;
  updatePolicyTree(tree: NotificationPolicyNode): MaybeAsync<void>;
  addChildPolicy(
    parentId: string,
    policy: Omit<NotificationPolicyNode, 'id' | 'children' | 'createdAt' | 'updatedAt'>,
  ): MaybeAsync<NotificationPolicyNode | undefined>;
  updatePolicy(
    id: string,
    patch: Partial<Omit<NotificationPolicyNode, 'id' | 'children' | 'createdAt'>>,
  ): MaybeAsync<NotificationPolicyNode | undefined>;
  deletePolicy(id: string): MaybeAsync<boolean>;

  // Mute Timings
  createMuteTiming(data: { name: string; timeIntervals: TimeInterval[] }): MaybeAsync<MuteTiming>;
  findAllMuteTimings(): MaybeAsync<MuteTiming[]>;
  findMuteTimingById(id: string): MaybeAsync<MuteTiming | undefined>;
  updateMuteTiming(id: string, patch: Partial<Omit<MuteTiming, 'id' | 'createdAt'>>): MaybeAsync<MuteTiming | undefined>;
  deleteMuteTiming(id: string): MaybeAsync<boolean>;

  // Routing
  isMuted(muteTimingIds: string[], now?: Date): MaybeAsync<boolean>;
  routeAlert(labels: Record<string, string>): MaybeAsync<Array<{ contactPointId: string; groupBy: string[]; isMuted: boolean }>>;
}

// — Version

export interface IVersionRepository {
  record(
    assetType: AssetType,
    assetId: string,
    snapshot: unknown,
    editedBy: string,
    editSource: EditSource,
    message?: string,
  ): MaybeAsync<AssetVersion>;
  getHistory(assetType: AssetType, assetId: string): MaybeAsync<AssetVersion[]>;
  getVersion(assetType: AssetType, assetId: string, version: number): MaybeAsync<AssetVersion | undefined>;
  getLatest(assetType: AssetType, assetId: string): MaybeAsync<AssetVersion | undefined>;
  rollback(assetType: AssetType, assetId: string, version: number): MaybeAsync<unknown | undefined>;
}

// — Workspace removed in T9 cutover. The org tenancy model from
//   docs/auth-perm-design/04-organizations.md is the replacement; see
//   `IOrgRepository` / `IOrgUserRepository` in
//   packages/common/src/repositories/auth/interfaces.ts.

// — InvestigationReport

export interface IInvestigationReportRepository {
  save(report: SavedInvestigationReport): MaybeAsync<void>;
  findById(id: string): MaybeAsync<SavedInvestigationReport | undefined>;
  findAll(): MaybeAsync<SavedInvestigationReport[]>;
  findByDashboard(dashboardId: string): MaybeAsync<SavedInvestigationReport[]>;
  delete(id: string): MaybeAsync<boolean>;
}

// — PostMortem

export interface IPostMortemRepository {
  set(incidentId: string, report: PostMortemReport): MaybeAsync<void>;
  get(incidentId: string): MaybeAsync<PostMortemReport | undefined>;
  has(incidentId: string): MaybeAsync<boolean>;
}

// — ChatSession

export interface ChatSessionScope {
  orgId?: string;
  ownerUserId?: string;
}

export interface IChatSessionRepository {
  create(session: {
    id: string;
    title?: string;
    orgId?: string;
    ownerUserId?: string;
  }): MaybeAsync<ChatSession>;
  findById(id: string, scope?: ChatSessionScope): MaybeAsync<ChatSession | undefined>;
  findAll(limit?: number, scope?: ChatSessionScope): MaybeAsync<ChatSession[]>;
  updateTitle(id: string, title: string, scope?: ChatSessionScope): MaybeAsync<ChatSession | undefined>;
  updateContextSummary(id: string, summary: string, scope?: ChatSessionScope): MaybeAsync<ChatSession | undefined>;
  delete(id: string, scope?: ChatSessionScope): MaybeAsync<boolean>;
}

// — ChatSessionContext

export interface ChatSessionContextResourceScope extends ChatSessionScope {
  resourceType: ChatSessionContextResourceType;
  resourceId: string;
}

export interface IChatSessionContextRepository {
  create(context: {
    id?: string;
    sessionId: string;
    orgId: string;
    ownerUserId: string;
    resourceType: ChatSessionContextResourceType;
    resourceId: string;
    relation: ChatSessionContextRelation;
    createdAt?: string;
  }): MaybeAsync<ChatSessionContext>;
  listBySession(sessionId: string, scope?: ChatSessionScope): MaybeAsync<ChatSessionContext[]>;
  listByResource(scope: ChatSessionContextResourceScope, limit?: number): MaybeAsync<ChatSessionContext[]>;
  deleteBySession(sessionId: string, scope?: ChatSessionScope): MaybeAsync<void>;
}

// — ChatMessage

export interface IChatMessageRepository {
  addMessage(sessionId: string, message: { id: string; role: string; content: string; actions?: unknown; timestamp: string }): MaybeAsync<ChatMessage>;
  getMessages(sessionId: string, limit?: number): MaybeAsync<ChatMessage[]>;
  getMessageCount(sessionId: string): MaybeAsync<number>;
  deleteBySession(sessionId: string): MaybeAsync<void>;
}

// — ChatSessionEvent (persisted SSE step trace)

export interface ChatSessionEventRecord {
  id: string;
  sessionId: string;
  seq: number;
  kind: string;
  payload: Record<string, unknown>;
  timestamp: string;
}

export interface IChatSessionEventRepository {
  append(event: ChatSessionEventRecord): MaybeAsync<void>;
  listBySession(sessionId: string): MaybeAsync<ChatSessionEventRecord[]>;
  nextSeq(sessionId: string): MaybeAsync<number>;
  deleteBySession(sessionId: string): MaybeAsync<void>;
  /**
   * Find the most recent event of a given kind in a session (by seq desc).
   * Used by metric_explore to inherit the prior chart's time range on
   * follow-up questions. Returns `null` when none exist.
   */
  findLatestByKind(
    sessionId: string,
    kind: string,
  ): MaybeAsync<ChatSessionEventRecord | null>;
}
