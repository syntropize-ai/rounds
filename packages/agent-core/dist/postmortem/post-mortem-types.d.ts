export interface PostMortemTimelineEntry {
    timestamp: string;
    description: string;
}
export interface PostMortemReport {
    id: string;
    incidentId: string;
    /** Executive summary of the incident */
    summary: string;
    /** User/revenue/service impact description */
    impact: string;
    /** Ordered timeline of key events */
    timeline: PostMortemTimelineEntry[];
    /** LLM-synthesised root cause analysis */
    rootCause: string;
    /** Concrete remediation steps that were taken */
    actionsTaken: string[];
    /** Insights and learnings from the incident */
    lessonsLearned: string[];
    /** Follow-up items to prevent recurrence */
    actionItems: string[];
    generatedAt: string;
    /** "llm" = full LLM output */
    generatedBy: 'llm';
}
export interface PostMortemIncidentInput {
    id: string;
    title: string;
    severity: string;
    status: string;
    services: string[];
    createdAt: string;
    resolvedAt?: string;
    timeline?: Array<{
        type: string;
        description: string;
        timestamp: string;
    }>;
}
export interface PostMortemInvestigationInput {
    id: string;
    intents: string;
    status: string;
    conclusionSummary?: string;
    hypotheses?: Array<{
        description: string;
        confidence: number;
    }>;
    evidence?: Array<{
        type: string;
        summary?: string;
    }>;
}
export interface PostMortemExecutionResult {
    action: string;
    targetService: string;
    success: boolean;
    output?: unknown;
    error?: string;
}
export interface PostMortemVerificationOutcome {
    outcome: string;
    reasoning: string;
    nextSteps: string[];
}
export interface PostMortemInput {
    incident: PostMortemIncidentInput;
    investigations: PostMortemInvestigationInput[];
    executionResults?: PostMortemExecutionResult[];
    verificationOutcomes?: PostMortemVerificationOutcome[];
}
//# sourceMappingURL=post-mortem-types.d.ts.map