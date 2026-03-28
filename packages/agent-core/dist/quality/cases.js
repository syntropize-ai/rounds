/**
 * Built-in benchmark cases covering common investigation scenarios.
 *
 * These cases are used as the default benchmark suite for drift detection.
 * Each case specifies a natural-language investigation prompt and the
 * expected output features the model should produce.
 */
export const BUILT_IN_CASES = [
    {
        id: 'latency-spike-deploy',
        description: 'Post-deploy latency spike on checkout service',
        message: 'Why did checkout latency p95 spike after deployment? p95 exceeded 800ms and SLO alarm fired.',
        expectedIntent: {
            taskType: 'explain_latency',
            entity: 'checkout',
        },
        expectedHypothesisKeywords: ['deploy', 'latency', 'p95'],
        expectedConclusionFields: ['summary', 'rootCause', 'recommendedActions'],
    },
    {
        id: 'error-rate-spike',
        description: 'Elevated error rate on payment service',
        message: 'payment-service error rate jumped to 5% in the last 30 minutes, what is wrong?',
        expectedIntent: {
            taskType: 'explain_errors',
            entity: 'payment',
        },
        expectedHypothesisKeywords: ['error', 'rate', 'payment'],
        expectedConclusionFields: ['summary', 'recommendedActions'],
    },
    {
        id: 'health-check',
        description: 'General health check of inventory service',
        message: 'Is inventory-service healthy? Any SLO breaches?',
        expectedIntent: {
            taskType: 'check_health',
            entity: 'inventory',
        },
        expectedHypothesisKeywords: ['health', 'inventory', 'slo'],
        expectedConclusionFields: ['summary'],
    },
    {
        id: 'config-change-impact',
        description: 'Config change impact investigation',
        message: 'We changed the database connection pool config for api-gateway 2 hours ago, could that have caused the slowdown?',
        expectedIntent: {
            taskType: 'investigate_change',
            entity: 'api-gateway',
        },
        expectedHypothesisKeywords: ['config', 'connection', 'pool'],
        expectedConclusionFields: ['summary', 'rootCause'],
    },
    {
        id: 'baseline-comparison',
        description: 'Compare current performance against historical baseline',
        message: 'How does checkout service performance this week compare to last week?',
        expectedIntent: {
            taskType: 'compare_baseline',
            entity: 'checkout',
        },
        expectedHypothesisKeywords: ['baseline', 'performance', 'compare'],
        expectedConclusionFields: ['summary'],
    },
];
//# sourceMappingURL=cases.js.map
