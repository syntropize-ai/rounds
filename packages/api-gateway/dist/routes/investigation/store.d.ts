import type { Investigation, InvestigationStatus, Hypothesis, Evidence } from '@agentic-obs/common';
import type { ExplanationResult } from '@agentic-obs/agent-core';
import type { FollowUpRecord, FeedbackBody } from './types.js';
import type { Persistable } from '../../persistence.js';
export interface StoredFeedback extends FeedbackBody {
    id: string;
    investigationId: string;
    createdAt: string;
}
export declare class InvestigationStore implements Persistable {
    private readonly investigations;
    private readonly archivedItems;
    private readonly followUps;
    private readonly feedback;
    private readonly conclusions;
    private readonly maxCapacity;
    /** tenantId tag per investigation id */
    private readonly tenants;
    constructor(maxCapacity?: number);
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
    }): Investigation;
    private _evictIfNeeded;
    findById(id: string): Investigation | undefined;
    getArchived(): Investigation[];
    restoreFromArchive(id: string): Investigation | undefined;
    findAll(tenantId?: string): Investigation[];
    updateStatus(id: string, status: InvestigationStatus): Investigation | undefined;
    updatePlan(id: string, plan: Investigation['plan']): Investigation | undefined;
    updateResult(id: string, result: {
        hypotheses: Hypothesis[];
        evidence: Evidence[];
        conclusion: ExplanationResult | null;
    }): Investigation | undefined;
    getConclusion(id: string): ExplanationResult | undefined;
    addFollowUp(investigationId: string, question: string): FollowUpRecord;
    getFollowUps(investigationId: string): FollowUpRecord[];
    addFeedback(investigationId: string, body: FeedbackBody): StoredFeedback;
    get size(): number;
    clear(): void;
    toJSON(): unknown;
    loadJSON(data: unknown): void;
}
/** Module-level singleton - replace with DI in production */
export declare const defaultInvestigationStore: InvestigationStore;
//# sourceMappingURL=store.d.ts.map
