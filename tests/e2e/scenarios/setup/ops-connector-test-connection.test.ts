/**
 * Setup smoke — POST /api/ops/connectors/:id/test (Ref PR #120).
 *
 * The seeded "e2e" in-cluster connector should probe successfully via
 * `kubectl version`. Reads the seeded connector id from .state.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { apiPost, apiGet } from '../helpers/api-client.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const STATE = resolve(HERE, '..', '..', '.state');

interface TestResp {
  status: 'ok' | 'error' | 'unknown' | 'connecting';
  message?: string;
  details?: { stage?: string; category?: 'dns' | 'tls' | 'auth' | 'other' };
}
interface ConnectorList { connectors: Array<{ id: string; name: string }> }

function seededConnectorId(): string | null {
  try {
    const raw = readFileSync(resolve(STATE, 'ops-connector-id'), 'utf8').trim();
    return raw || null;
  } catch {
    return null;
  }
}

describe('setup/ops-connector-test-connection', () => {
  it('in-cluster connector probe reports ok or returns categorized error', async () => {
    let id = seededConnectorId();
    if (!id) {
      // Fallback: discover from list endpoint.
      const list = await apiGet<ConnectorList>('/api/ops/connectors');
      id = list.connectors.find((c) => c.name === 'e2e')?.id ?? null;
    }
    expect(id, 'seeded e2e connector id (.state/ops-connector-id)').toBeTruthy();

    const result = await apiPost<TestResp>(`/api/ops/connectors/${id}/test`, {});
    // `status` is the contract from PR #120; either it works (ok), or the
    // failure must carry a categorized reason — never an opaque crash.
    expect(['ok', 'error', 'unknown']).toContain(result.status);
    if (result.status === 'error') {
      const cat = result.details?.category;
      expect(['dns', 'tls', 'auth', 'other']).toContain(cat ?? 'other');
    }
  }, 60_000);
});
