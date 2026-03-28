/**
 * Pure scoring functions for benchmark quality metrics.
 */
// Weights for composite overall score
const WEIGHT_INTENT = 0.4;
const WEIGHT_HYPOTHESIS = 0.3;
const WEIGHT_CONCLUSION = 0.3;
/**
 * Score a single benchmark case run.
 *
 * @param base     The benchmark case definition.
 * @param intent   The parsed intent (or null if parsing failed).
 * @param pipeline The pipeline result (or null if not run).
 */
export function scoreBenchmarkRun(base, intent, pipeline) {
    const intentAccuracy = scoreIntent(base, intent);
    const hypothesisKeywordRate = scoreHypothesisKeywords(base, pipeline);
    const conclusionCompleteness = scoreConclusionFields(base, pipeline);
    const overallScore = intentAccuracy * WEIGHT_INTENT +
        hypothesisKeywordRate * WEIGHT_HYPOTHESIS +
        conclusionCompleteness * WEIGHT_CONCLUSION;
    return {
        caseId: base.id,
        runAt: new Date().toISOString(),
        intentAccuracy,
        hypothesisKeywordRate,
        conclusionCompleteness,
        overallScore,
    };
}
/** Score intent: 1.0 = both taskType and entity match, 0.5 = one, 0.0 = neither. */
export function scoreIntent(base, intent) {
    if (!intent) {
        return 0;
    }
    const taskTypeMatch = intent.taskType === base.expectedIntent.taskType ? 1 : 0;
    const entityMatch = (intent.entity.toLowerCase() === base.expectedIntent.entity.toLowerCase() ||
        base.expectedIntent.entity.toLowerCase().includes(intent.entity.toLowerCase()));
    return (taskTypeMatch + Number(entityMatch)) / 2;
}
/**
 * Score hypothesis keyword coverage.
 * For each expected keyword, checks if any hypothesis description contains it
 * (case-insensitive). Returns fraction of matched keywords.
 */
export function scoreHypothesisKeywords(base, pipeline) {
    if (!pipeline || base.expectedHypothesisKeywords.length === 0) {
        return 0;
    }
    const hypothesisDescriptions = pipeline.hypothesisDescriptions ?? [];
    const allText = hypothesisDescriptions.join(' ').toLowerCase();
    const matched = base.expectedHypothesisKeywords.filter((kw) => allText.includes(kw.toLowerCase()));
    return matched.length / base.expectedHypothesisKeywords.length;
}
/**
 * Score conclusion structural completeness.
 * For each expected field, checks whether the conclusion has a non-empty value.
 */
export function scoreConclusionFields(base, pipeline) {
    if (!pipeline || base.expectedConclusionFields.length === 0) {
        return 0;
    }
    const { conclusionFields } = pipeline;
    const present = base.expectedConclusionFields.filter((field) => {
        const value = conclusionFields?.[field];
        if (value === null || value === undefined)
            return false;
        if (typeof value === 'string')
            return value.trim().length > 0;
        if (Array.isArray(value))
            return value.length > 0;
        return true;
    });
    return present.length / base.expectedConclusionFields.length;
}
//# sourceMappingURL=scorer.js.map
