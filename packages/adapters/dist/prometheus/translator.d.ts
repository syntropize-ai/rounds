import type { SemanticQuery } from '../types.js';

export interface TranslatedQuery {
    promql: string;
    window: string;
}

/**
 * Translate a SemanticQuery into a PromQL expression.
 * Throws if the metric name is not supported.
 */
export declare function translateToPromQL(query: SemanticQuery): TranslatedQuery;

export declare function getSupportedMetrics(): string[];

//# sourceMappingURL=translator.d.ts.map