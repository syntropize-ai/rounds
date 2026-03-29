import type { PromQlEvaluator } from '@agentic-obs/agent-core';
/**
 * Adapter that evaluates PromQL queries against a Prometheus-compatible endpoint.
 * Returns scalar result from instant query.
 */
export declare class PrometheusPromQlEvaluator implements PromQlEvaluator {
    private readonly baseUrl;
    private readonly headers;
    constructor(baseUrl: string, headers?: Record<string, string>);
    evaluate(query: string): Promise<number | undefined>;
}
//# sourceMappingURL=alert-promql-adapter.d.ts.map
