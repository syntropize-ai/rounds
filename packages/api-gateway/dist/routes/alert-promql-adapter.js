/**
 * Adapter that evaluates PromQL queries against a Prometheus-compatible endpoint.
 * Returns scalar result from instant query.
 */
export class PrometheusPromQlEvaluator {
    baseUrl;
    headers;
    constructor(baseUrl, headers = {}) {
        this.baseUrl = baseUrl;
        this.headers = headers;
    }
    async evaluate(query) {
        try {
            const url = `${this.baseUrl}/api/v1/query?query=${encodeURIComponent(query)}`;
            const resp = await fetch(url, {
                headers: this.headers,
                signal: AbortSignal.timeout(10_000),
            });
            if (!resp.ok) {
                return undefined;
            }
            const data = await resp.json();
            if (data.status !== 'success' || !data.data?.result?.length) {
                return undefined;
            }
            const first = data.data.result[0];
            if (!first) {
                return undefined;
            }
            // Instant query returns [timestamp, value] tuple
            const val = first.value?.[1];
            if (!val) {
                return undefined;
            }
            const num = parseFloat(val);
            return isNaN(num) ? undefined : num;
        }
        catch {
            return undefined;
        }
    }
}
//# sourceMappingURL=alert-promql-adapter.js.map
