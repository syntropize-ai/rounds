import { Router } from 'express';
import type { IGatewayInvestigationStore, IGatewayFeedStore } from '@agentic-obs/data-layer';
export interface DailyTrend {
    /** YYYY-MM-DD */
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
    adoption_rate: number;
    avg_investigation_duration_ms: number;
    avg_tokens_per_investigation: number;
    avg_queries_per_investigation: number;
    evidence_completeness: number;
    proactive_hit_rate: number;
    daily_trend: DailyTrend[];
    weekly_trend: WeeklyTrend[];
    computed_at: string;
}
export declare function computeQualityMetrics(investigationStore: IGatewayInvestigationStore, feedStoreInstance: IGatewayFeedStore): Promise<QualityMetrics>;
export interface MetaRouterDeps {
    investigationStore: IGatewayInvestigationStore;
    feedStore: IGatewayFeedStore;
}
export declare function createMetaRouter(deps: MetaRouterDeps): Router;
//# sourceMappingURL=meta.d.ts.map