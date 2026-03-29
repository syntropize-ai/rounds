export declare const metaRouter: import("express-serve-static-core").Router;
export interface DailyTrend {
    date: string;
    investigations: number;
    avg_duration_ms: number;
}
export interface WeeklyTrend {
    /** ISO week start date (Monday) */
    week_start: string;
    investigations: number;
    avg_duration_ms: number;
}
export interface QualityMetrics {
    total_investigations: number;
    /**
     * Fraction of feed items with positive feedback (useful / root_cause_correct)
     * among those that received any feedback. NaN-safe: returns 0 when no feedback.
     */
    adoption_rate: number;
    /**
     * Average wall-clock duration (ms) of completed investigations.
     * Computed as updatedAt - createdAt for status=completed.
     */
    avg_investigation_duration_ms: number;
    /**
     * Average total token cost per investigation (sum of step costs).
     * 0 when no cost data is available.
     */
    avg_tokens_per_investigation: number;
    /**
     * Average total query count per investigation (sum of step query counts).
     * 0 when no cost data is available.
     */
    avg_queries_per_investigation: number;
    /**
     * Average evidence items per hypothesis, averaged across investigations.
     * Measures how thoroughly each hypothesis was investigated.
     */
    evidence_completeness: number;
    /**
     * Fraction of proactive feed items (anomaly_detected / change_impact) where
     * the user followed up by navigating into the investigation.
     * 0 when no proactive items exist.
     */
    proactive_hit_rate: number;
    daily_trend: DailyTrend[];
    weekly_trend: WeeklyTrend[];
    computed_at: string;
}
export declare function computeQualityMetrics(): QualityMetrics;
//# sourceMappingURL=meta.d.ts.map
