export interface FeedbackStats {
    total: number;
    adopted: number;
    satisfactionRate: number;
}
export declare class FeedbackAggregator {
    private readonly entries;
    /**
     * Record a feedback signal: whether a recommended action for a
     * [serviceId, symptomType] pair was adopted by the operator.
     */
    recordFeedback(serviceId: string, symptomType: string, adopted: boolean): void;
    /**
     * Aggregate feedback statistics.
     * Pass a `serviceId` to scope to one service; omit for global stats.
     */
    getStats(serviceId?: string): FeedbackStats;
    /**
     * Generate an LLM context hint string summarizing past adoption patterns
     * for a given service. Returns null when there is no history yet.
     *
     * The hint is designed to be injected directly into an LLM system prompt
     * to steer future recommendations toward actions operators have found useful.
     */
    getContextHint(serviceId: string): string | null;
    /** Total number of recorded feedback entries (across all services). */
    get size(): number;
}
//# sourceMappingURL=feedback-aggregator.d.ts.map
