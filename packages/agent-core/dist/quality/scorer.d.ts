/**
 * Pure scoring functions for benchmark quality metrics.
 */
import type { BenchmarkCase, BenchmarkScore, PipelineResult } from './types.js';
import type { StructuredIntent } from '@agentic-obs/common';
/** Score a single benchmark case run. */
export declare function scoreBenchmarkRun(base: BenchmarkCase, intent: StructuredIntent | null, pipeline: PipelineResult | null): BenchmarkScore;
/** Score intent: 1.0 = both taskType and entity match, 0.5 = one, 0.0 = neither. */
export declare function scoreIntent(base: BenchmarkCase, intent: StructuredIntent | null): number;
/**
 * Score hypothesis keyword coverage.
 * For each expected keyword, checks if any hypothesis description contains it
 * (case-insensitive). Returns fraction of matched keywords.
 */
export declare function scoreHypothesisKeywords(base: BenchmarkCase, pipeline: PipelineResult | null): number;
/**
 * Score conclusion structural completeness.
 * For each expected field, checks whether the conclusion has a non-empty value.
 */
export declare function scoreConclusionFields(base: BenchmarkCase, pipeline: PipelineResult | null): number;
//# sourceMappingURL=scorer.d.ts.map
