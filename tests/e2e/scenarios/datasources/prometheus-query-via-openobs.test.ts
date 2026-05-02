/**
 * POST /api/query/instant routes through openobs's prometheus adapter
 * pipeline. Asserting we get a numeric `up` sample back proves the full
 * datasource resolution + adapter path.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { apiPost } from '../helpers/api-client.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const STATE = resolve(HERE, '..', '..', '.state');

interface InstantResp {
  status?: 'success' | 'error';
  data?: { resultType: string; result: Array<{ metric: Record<string, string>; value: [number, string] }> };
}

function promDsId(): string {
  const raw = readFileSync(resolve(STATE, 'prometheus-datasource-id'), 'utf8').trim();
  if (!raw) throw new Error('.state/prometheus-datasource-id missing — run seed.sh');
  return raw;
}

describe('datasources/prometheus-query-via-openobs', () => {
  it('instant query for up{app="web-api"} returns a numeric sample', async () => {
    const result = await apiPost<InstantResp>('/api/query/instant', {
      query: 'up{app="web-api"}',
      datasourceId: promDsId(),
    });
    expect(result.status === 'success' || Array.isArray(result.data?.result)).toBe(true);
    const samples = result.data?.result ?? [];
    expect(samples.length).toBeGreaterThan(0);
    const value = Number.parseFloat(samples[0]!.value[1]);
    expect(Number.isFinite(value)).toBe(true);
  }, 30_000);
});
