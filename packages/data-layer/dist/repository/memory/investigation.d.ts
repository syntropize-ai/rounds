import type { Investigation } from '@agentic-obs/common';
import type { ExplanationResult } from '@agentic-obs/common';
import type { IInvestigationRepository, InvestigationFindAllOptions } from '../interfaces.js';
import type { FollowUpRecord, FeedbackBody, StoredFeedback } from '../../stores/investigation-store.js';
export declare class InMemoryInvestigationRepository implements IInvestigationRepository {
    private readonly active;
    private readonly archived;
    private readonly followUps;
    private readonly feedbackMap;
    private readonly conclusions;
    private readonly workspaceMap;
    findById(id: string): Promise<Investigation | undefined>;
    findAll(opts?: InvestigationFindAllOptions): Promise<Investigation[]>;
    create(data: Omit<Investigation, 'id' | 'createdAt'> & {
        id?: string;
    }): Promise<Investigation>;
    update(id: string, patch: Partial<Omit<Investigation, 'id'>>): Promise<Investigation | undefined>;
    delete(id: string): Promise<boolean>;
    count(): Promise<number>;
    findBySession(sessionId: string): Promise<Investigation[]>;
    findByUser(userId: string, _tenantId?: string): Promise<Investigation[]>;
    archive(id: string): Promise<Investigation | undefined>;
    restore(id: string): Promise<Investigation | undefined>;
    findArchived(_tenantId?: string): Promise<Investigation[]>;
    findByWorkspace(workspaceId: string): Promise<Investigation[]>;
    addFollowUp(investigationId: string, question: string): Promise<FollowUpRecord>;
    getFollowUps(investigationId: string): Promise<FollowUpRecord[]>;
    addFeedback(investigationId: string, body: FeedbackBody): Promise<StoredFeedback>;
    getConclusion(id: string): Promise<ExplanationResult | undefined>;
    setConclusion(id: string, conclusion: ExplanationResult): Promise<void>;
    updateStatus(id: string, status: string): Promise<Investigation | undefined>;
    updatePlan(id: string, plan: Investigation['plan']): Promise<Investigation | undefined>;
    updateResult(id: string, result: {
        hypotheses: Investigation['hypotheses'];
        evidence: Investigation['evidence'];
        conclusion: ExplanationResult | null;
    }): Promise<Investigation | undefined>;
    /** Test helper */
    clear(): void;
}
//# sourceMappingURL=investigation.d.ts.map