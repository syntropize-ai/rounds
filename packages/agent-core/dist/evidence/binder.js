/**
 * Evidence Binder - maps StepFindings to hypotheses as supporting or counter evidence.
 *
 * Rule-based approach: each step type has known semantic relevance to hypothesis types.
 * A finding is "supporting" when it confirms the hypothesis direction (anomaly present),
 * and "counter" when it argues against it (no anomaly found).
 */
let _idCounter = 0;

function nextId() {
    return `ev_${Date.now()}_${++_idCounter}`;
}

function classifyHypothesis(hypothesis) {
    const desc = hypothesis.description.toLowerCase();
    if (desc.includes('latency') || desc.includes('slow') || desc.includes('p95') || desc.includes('p99')) {
        return 'latency';
    }
    if (desc.includes('error') || desc.includes('fail') || desc.includes('5xx')) {
        return 'error';
    }
    if (desc.includes('deploy') || desc.includes('release') || desc.includes('config') || desc.includes('change')) {
        return 'deployment';
    }
    if (desc.includes('downstream') || desc.includes('dependency') || desc.includes('upstream')) {
        return 'downstream';
    }
    if (desc.includes('saturation') || desc.includes('cpu') || desc.includes('memory') || desc.includes('resource')) {
        return 'resource';
    }
    return 'unknown';
}

// -- Relevance scoring --------------------------------------------------------
/**
 * Returns a relevance score (0-1) for how much a step type relates to
 * a hypothesis category. 0 = not relevant, 1 = highly relevant.
 */
function relevanceScore(stepType, category) {
    const matrix = {
        compare_latency_vs_baseline: { latency: 1.0, error: 0.3, downstream: 0.4, unknown: 0.3 },
        check_error_rate:            { error: 1.0, latency: 0.3, deployment: 0.4, unknown: 0.3 },
        inspect_downstream:          { downstream: 1.0, latency: 0.5, error: 0.5, unknown: 0.2 },
        correlate_deployments:       { deployment: 1.0, latency: 0.6, error: 0.6, unknown: 0.4 },
        sample_traces:               { latency: 0.7, error: 0.7, downstream: 0.5, unknown: 0.3 },
        cluster_logs:                { error: 0.8, latency: 0.4, deployment: 0.3, unknown: 0.3 },
    };
    return matrix[stepType]?.[category] ?? 0.1;
}

// -- Evidence creation --------------------------------------------------------
function findingToEvidenceType(stepType) {
    switch (stepType) {
        case 'correlate_deployments': return 'change';
        case 'sample_traces':         return 'trace_waterfall';
        case 'cluster_logs':          return 'log_cluster';
        default:                      return 'metric';
    }
}

function createEvidence(hypothesisId, finding, timestamp) {
    return {
        id: nextId(),
        hypothesisId,
        type: findingToEvidenceType(finding.stepType),
        query: finding.replayableQuery?.query ?? finding.stepType,
        queryLanguage: finding.replayableQuery?.queryLanguage ?? 'investigation-step',
        result: {
            summary: finding.summary,
            value: finding.value,
            baseline: finding.baseline,
            deviationRatio: finding.deviationRatio,
            rawData: finding.rawData,
        },
        summary: finding.summary,
        timestamp,
        reproducible: finding.replayableQuery !== undefined,
    };
}

// -- Confidence update rules --------------------------------------------------
function computeConfidenceDelta(finding, isSupporting, relevance) {
    const magnitude = finding.isAnomaly ? 0.2 : 0.05;
    const sign = isSupporting ? 1 : -1;
    return sign * magnitude * relevance;
}

/**
 * Bind a list of step findings to a hypothesis.
 * Returns evidence items that are relevant to the hypothesis, along with
 * whether each piece is supporting or counter, and the confidence delta.
 */
export function bindFindingsToHypothesis(hypothesis, findings, timestamp, options = {}) {
    const minRelevance = options.minRelevance ?? 0.2;
    const category = classifyHypothesis(hypothesis);
    const bound = [];
    for (const finding of findings) {
        const relevance = relevanceScore(finding.stepType, category);
        if (relevance < minRelevance)
            continue;
        // A finding SUPPORTS the hypothesis when it's anomalous and relevant;
        // it COUNTERS the hypothesis when no anomaly was found (the suspected cause is absent).
        const isSupporting = finding.isAnomaly;
        const confidenceDelta = computeConfidenceDelta(finding, isSupporting, relevance);
        const evidence = createEvidence(hypothesis.id, finding, timestamp);
        bound.push({ evidence, isSupporting, confidenceDelta });
    }
    return bound;
}

/**
 * Clamp a confidence value to [0, 1].
 */
export function clampConfidence(value) {
    return Math.max(0, Math.min(1, value));
}

/**
 * Derive hypothesis status from updated confidence and evidence pattern.
 */
export function deriveStatus(confidence, supportCount, counterCount) {
    if (confidence >= 0.75 && supportCount > 0)
        return 'supported';
    if (confidence <= 0.2 && counterCount > supportCount)
        return 'refuted';
    if (supportCount === 0 && counterCount === 0)
        return 'investigating';
    return 'inconclusive';
}
//# sourceMappingURL=binder.js.map