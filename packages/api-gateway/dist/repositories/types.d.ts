import type { Investigation, InvestigationStatus, Hypothesis, Evidence, Incident, IncidentTimelineEntry, Dashboard, DashboardStatus, DashboardVariable, PanelConfig, DashboardMessage } from '@agentic-obs/common';
import type { ExplanationResult } from '@agentic-obs/common';
import type { FeedItem, FeedPage, FeedListOptions, FeedEventType, FeedSeverity, FeedFeedback, HypothesisFeedback, ActionFeedback, FeedbackStats } from '../routes/feed-store.js';
import type { FollowUpRecord, FeedbackBody, StoredFeedback } from '../routes/investigation/types.js';
import type { CreateIncidentParamsWithTenant, UpdateIncidentParams } from '../routes/incident-store.js';
import type { ApprovalRequest } from '../routes/approval-store.js';
import type { ShareLink, SharePermission } from '../routes/investigation/share-store.js';
export type MaybeAsync<T> = T | Promise<T>;
export interface IGatewayInvestigationStore {
    create(params: {
        question: string;
        sessionId: string;
        userId: string;
        entity?: string;
        timeRange?: {
            start: string;
            end: string;
        };
        tenantId?: string;
    }): MaybeAsync<Investigation>;
    findById(id: string): MaybeAsync<Investigation | undefined>;
    findAll(tenantId?: string): MaybeAsync<Investigation[]>;
    getArchived(): MaybeAsync<Investigation[]>;
    restoreFromArchive(id: string): MaybeAsync<Investigation | undefined>;
    addFollowUp(investigationId: string, question: string): MaybeAsync<FollowUpRecord>;
    addFeedback(investigationId: string, body: FeedbackBody): MaybeAsync<StoredFeedback>;
    getConclusion(id: string): MaybeAsync<ExplanationResult | undefined>;
    updateStatus(id: string, status: InvestigationStatus): MaybeAsync<Investigation | undefined>;
    updatePlan(id: string, plan: Investigation['plan']): MaybeAsync<Investigation | undefined>;
    updateResult(id: string, result: {
        hypotheses: Hypothesis[];
        evidence: Evidence[];
        conclusion: ExplanationResult | null;
    }): MaybeAsync<Investigation | undefined>;
}
export interface IGatewayIncidentStore {
    create(params: CreateIncidentParamsWithTenant): MaybeAsync<Incident>;
    findById(id: string): MaybeAsync<Incident | undefined>;
    findAll(tenantId?: string): MaybeAsync<Incident[]>;
    getArchived(): MaybeAsync<Incident[]>;
    restoreFromArchive(id: string): MaybeAsync<Incident | undefined>;
    update(id: string, params: UpdateIncidentParams): MaybeAsync<Incident | undefined>;
    addInvestigation(incidentId: string, investigationId: string): MaybeAsync<Incident | undefined>;
    getTimeline(incidentId: string): MaybeAsync<IncidentTimelineEntry[] | undefined>;
}
export interface IGatewayFeedStore {
    list(options?: FeedListOptions): MaybeAsync<FeedPage>;
    get(id: string): MaybeAsync<FeedItem | undefined>;
    markRead(id: string): MaybeAsync<FeedItem | undefined>;
    markFollowedUp(id: string): MaybeAsync<FeedItem | undefined>;
    addFeedback(id: string, feedback: FeedFeedback, comment?: string): MaybeAsync<FeedItem | undefined>;
    addHypothesisFeedback(id: string, feedback: HypothesisFeedback): MaybeAsync<FeedItem | undefined>;
    addActionFeedback(id: string, feedback: ActionFeedback): MaybeAsync<FeedItem | undefined>;
    getUnreadCount(): MaybeAsync<number>;
    getStats(): MaybeAsync<FeedbackStats>;
    /** Subscribe to new feed items; returns an unsubscribe function. Always sync. */
    subscribe(fn: (item: FeedItem) => void): () => void;
    add(type: FeedEventType, title: string, summary: string, severity: FeedSeverity, investigationId?: string, tenantId?: string): MaybeAsync<FeedItem>;
}
export interface IGatewayApprovalStore {
    findById(id: string): MaybeAsync<ApprovalRequest | undefined>;
    listPending(): MaybeAsync<ApprovalRequest[]>;
    approve(id: string, by: string, roles?: string[]): MaybeAsync<ApprovalRequest | undefined>;
    reject(id: string, by: string, roles?: string[]): MaybeAsync<ApprovalRequest | undefined>;
    override(id: string, by: string, roles?: string[]): MaybeAsync<ApprovalRequest | undefined>;
}
export interface IGatewayShareStore {
    findByToken(token: string): MaybeAsync<ShareLink | undefined>;
    findByInvestigation(investigationId: string): MaybeAsync<ShareLink[]>;
    revoke(token: string): MaybeAsync<boolean>;
    create(params: {
        investigationId: string;
        createdBy: string;
        permission?: SharePermission;
        expiresInMs?: number;
    }): MaybeAsync<ShareLink>;
}
export interface IGatewayDashboardStore {
    create(params: {
        title: string;
        description: string;
        prompt: string;
        userId: string;
        datasourceIds: string[];
        useExistingMetrics?: boolean;
        folder?: string;
    }): MaybeAsync<Dashboard>;
    findById(id: string): MaybeAsync<Dashboard | undefined>;
    findAll(userId?: string): MaybeAsync<Dashboard[]>;
    update(id: string, patch: Partial<Pick<Dashboard, 'type' | 'title' | 'description' | 'panels' | 'variables' | 'refreshIntervalSec' | 'folder'>>): MaybeAsync<Dashboard | undefined>;
    updateStatus(id: string, status: DashboardStatus, error?: string): MaybeAsync<Dashboard | undefined>;
    updatePanels(id: string, panels: PanelConfig[]): MaybeAsync<Dashboard | undefined>;
    updateVariables(id: string, variables: DashboardVariable[]): MaybeAsync<Dashboard | undefined>;
    delete(id: string): MaybeAsync<boolean>;
}
export interface IConversationStore {
    addMessage(dashboardId: string, msg: DashboardMessage): DashboardMessage;
    getMessages(dashboardId: string): DashboardMessage[];
    clearMessages(dashboardId: string): void;
    deleteConversation(dashboardId: string): void;
}
export interface GatewayStores {
    investigations: IGatewayInvestigationStore;
    incidents: IGatewayIncidentStore;
    feed: IGatewayFeedStore;
    approvals: IGatewayApprovalStore;
    shares: IGatewayShareStore;
    dashboards: IGatewayDashboardStore;
    conversations: IConversationStore;
}
//# sourceMappingURL=types.d.ts.map
