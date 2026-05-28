/**
 * Normalize a Prometheus-compatible base URL.
 *
 * Trims whitespace, strips trailing slashes, and removes a trailing `/api/v1`
 * so users pasting either the API root, an AMP workspace URL, or a Grafana
 * datasource proxy URL all converge on the same base. Idempotent under
 * repeated `/api/v1` suffixes.
 */
export function normalizePrometheusBaseUrl(url: string): string {
  let out = url.trim().replace(/\/+$/, '');
  while (out.endsWith('/api/v1')) out = out.slice(0, -'/api/v1'.length);
  return out;
}
