import type { InvestigationPlan, InvestigationStatus } from '@agentic-obs/common';
export interface CreateInvestigationBody {
    /** Natural-language question from the user */
    question: string;
    /** Session id to attach the investigation to */
    sessionId?: string;
    /** Optional entity hint (e.g. "checkout-service") */
    entity?: string;
    /** Optional time range hint (ISO-8601 strings) */
    timeRange?: {
        start: string;
        end: string;
    };
}
export interface FollowUpBody {
    question: string;
}
export interface FeedbackBody {
    /** Whether the investigation result was useful */
    helpful: boolean;
    /** Optional free-text comment from the user */
    comment?: string;
    /** Explicit verdict on the identified root cause */
    rootCauseVerdict?: 'correct' | 'wrong' | 'partially_correct';
    /** Per-hypothesis verdicts (array replaces single hypothesisId for multi-hypothesis feedback) */
    hypothesisFeedback?: Array<{
        hypothesisId: string;
        verdicts: 'correct' | 'wrong';
        comment?: string;
    }>;
    /** Per-action verdicts */
    actionFeedback?: Array<{
        actionId: string;
        helpful: boolean;
        comment?: string;
    }>;
}
export interface InvestigationSummary {
    id: string;
    status: InvestigationStatus;
    question: string;
    sessionId: string;
    userId: string;
    createdAt: string;
    updatedAt: string;
}
export interface PlanResponse {
    investigationId: string;
    plan: InvestigationPlan;
}
export interface FollowUpRecord {
    id: string;
    investigationId: string;
    question: string;
    createdAt: string;
}
export interface FeedbackResponse {
    received: boolean;
    investigationId: string;
}
export type SseEventType = 'investigationcreated' | 'investigationstatus' | 'investigationstep' | 'investigationhypothesis' | 'investigationcomplete' | 'investigationerror' | 'connected' | 'feed_item';
export interface SseEvent<T = unknown> {
    type: SseEventType;
    data?: T;
}
//# sourceMappingURL=types.d.ts.map
