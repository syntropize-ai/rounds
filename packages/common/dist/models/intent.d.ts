export interface StructuredIntent {
    taskType: 'explain_latency' | 'explain_errors' | 'check_health' | 'compare_baseline' | 'investigate_change' | 'general_query';
    entity: string;
    signal?: string;
    timeRange: {
        start: string;
        end: string;
    };
    goal: string;
    constraints?: Record<string, unknown>;
}
//# sourceMappingURL=intent.d.ts.map