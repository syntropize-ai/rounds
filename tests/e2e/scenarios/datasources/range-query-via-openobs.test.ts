/**
 * Range query proxy: POST /api/query/range returns a series with sample
 * points.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { apiPost } from '../helpers/api-client.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const STATE = resolve(HERE, '..', '..', '.state');

interface RangeResp {
  status?: 'success' | 'error';
  data?: {
    resultType: string;
    result: Array<{ metric: Record<string, string>; values: Array<[number, string]> }>;
  };
}

function promDsId(): string {
  const raw = readFileSync(resolve(STATE, 'prometheus-datasource-id'), 'utf8').trim();
  if (!raw) throw new Error('.state/prometheus-datasource-id missing — run seed.sh');
  return raw;
}

describe('datasources/range-query-via-openobs', () => {
  it('range query returns at least one series with sample points', async () => {
    const end = new Date();
    const start = new Date(end.getTime() - 5 * 60 * 1000);
    const result = await apiPost<RangeResp>('/api/query/range', {
      query: 'up{app="web-api"}',
      datasourceId: promDsId(),
      start: start.toISOString(),
      end: end.toISOString(),
      step: '30s',
    });
    const series = result.data?.result ?? [];
    expect(series.length).toBeGreaterThan(0);
    expect(series[0]!.values.length).toBeGreaterThan(0);
  }, 30_000);
});
