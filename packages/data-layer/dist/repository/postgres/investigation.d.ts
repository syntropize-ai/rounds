import type { Investigation } from '@agentic-obs/common';
import type { ExplanationResult } from '@agentic-obs/common';
import type { DbClient } from '../../db/client.js';
import type { IInvestigationRepository, InvestigationFindAllOptions } from '../interfaces.js';
import type { FollowUpRecord, FeedbackBody, StoredFeedback } from '../../stores/investigation-store.js';
export declare class PostgresInvestigationRepository implements IInvestigationRepository {
    private readonly db;
    constructor(db: DbClient);
    findById(id: string): Promise<Investigation | undefined>;
    findAll(opts?: InvestigationFindAllOptions): Promise<Investigation[]>;
    create(data: Omit<Investigation, 'id' | 'createdAt'> & {
        id?: string;
    }): Promise<Investigation>;
    update(id: string, patch: Partial<Omit<Investigation, 'id'>>): Promise<Investigation | undefined>;
    delete(id: string): Promise<boolean>;
    count(): Promise<number>;
    findBySession(sessionId: string): Promise<Investigation[]>;
    findByUser(userId: string, tenantId?: string): Promise<Investigation[]>;
    archive(id: string): Promise<Investigation | undefined>;
    restore(id: string): Promise<Investigation | undefined>;
    findArchived(tenantId?: string): Promise<Investigation[]>;
    findByWorkspace(_workspaceId: string): Promise<Investigation[]>;
    addFollowUp(investigationId: string, question: string): Promise<FollowUpRecord>;
    getFollowUps(_investigationId: string): Promise<FollowUpRecord[]>;
    addFeedback(investigationId: string, body: FeedbackBody): Promise<StoredFeedback>;
    getConclusion(_id: string): Promise<ExplanationResult | undefined>;
    setConclusion(_id: string, _conclusion: ExplanationResult): Promise<void>;
    updateStatus(id: string, status: string): Promise<Investigation | undefined>;
    updatePlan(id: string, plan: Investigation['plan']): Promise<Investigation | undefined>;
    updateResult(id: string, result: {
        hypotheses: Investigation['hypotheses'];
        evidence: Investigation['evidence'];
        conclusion: ExplanationResult | null;
    }): Promise<Investigation | undefined>;
}
//# sourceMappingURL=investigation.d.ts.map