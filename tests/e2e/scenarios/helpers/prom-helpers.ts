/**
 * Direct prometheus helpers for fixture-state assertions.
 *
 * We go through openobs's `/api/query` proxy when possible (which uses
 * the prometheus datasource id seeded by seed.sh), but fall back to a
 * direct HTTP call on `OPENOBS_TEST_PROM_DIRECT_URL` (typically a kit.sh
 * port-forward at http://127.0.0.1:9090) for raw shape checks.
 */
import { pollUntil } from './wait.js';

const PROM_DIRECT_URL =
  process.env['OPENOBS_TEST_PROM_DIRECT_URL'] ?? 'http://127.0.0.1:9090';

interface PromInstantResponse {
  status: 'success' | 'error';
  data?: {
    resultType: string;
    result: Array<{ metric: Record<string, string>; value: [number, string] }>;
  };
  error?: string;
}

export async function promQuery(query: string): Promise<number | null> {
  const url = `${PROM_DIRECT_URL}/api/v1/query?query=${encodeURIComponent(query)}`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`prom ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
  const body = (await res.json()) as PromInstantResponse;
  if (body.status !== 'success' || !body.data) return null;
  const first = body.data.result[0];
  if (!first) return null;
  const v = Number.parseFloat(first.value[1]);
  return Number.isFinite(v) ? v : null;
}

export async function awaitRate(
  promQL: string,
  predicate: (v: number) => boolean,
  timeoutMs: number,
): Promise<number> {
  return pollUntil<number>(
    async () => {
      const v = await promQuery(promQL);
      if (v === null) return null;
      return predicate(v) ? v : null;
    },
    {
      timeoutMs,
      intervalMs: 2000,
      label: `awaitRate(${promQL})`,
    },
  );
}
