import type { PromQLEvaluator } from '@agentic-obs/agent-core';

/**
 * Adapter that evaluates PromQL queries against a Prometheus-compatible endpoint.
 * Returns scalar result from instant query.
 */
export class PrometheusPromQlEvaluator implements PromQLEvaluator {
  constructor(
    private readonly baseUrl: string,
    private readonly headers: Record<string, string> = {},
  ) {}

  async evaluate(query: string): Promise<number | undefined> {
    try {
      const url = `${this.baseUrl}/api/v1/query?query=${encodeURIComponent(query)}`;
      const resp = await fetch(url, {
        headers: this.headers,
        signal: AbortSignal.timeout(10_000),
      });
      if (!resp.ok)
        return undefined;

      const data = await resp.json() as {
        status?: string;
        data?: {
          resultType?: string;
          result?: Array<{ value?: [number, string]; metric?: Record<string, string> }>;
        };
      };

      if (data.status !== 'success' || !data.data?.result?.length)
        return undefined;

      const first = data.data.result[0];
      if (!first)
        return undefined;

      const val = first.value?.[1];
      if (val === undefined)
        return undefined;

      const num = parseFloat(val);
      return Number.isNaN(num) ? undefined : num;
    } catch {
      return undefined;
    }
  }
}
