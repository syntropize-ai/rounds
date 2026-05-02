/**
 * Thin wrappers over /api/ops/connectors for tests that need to spin up
 * scoped connectors and tear them down. Reuses the SA token via
 * api-client.ts.
 */
import { apiPost, apiDelete } from './api-client.js';

export interface CreateConnectorOpts {
  name: string;
  mode?: 'in-cluster' | 'kubeconfig' | 'manual';
  allowedNamespaces?: string[];
  capabilities?: string[];
  manual?: { server: string; token: string; caData?: string; insecureSkipTlsVerify?: boolean };
  secret?: string;
}

interface CreateConnectorResponse {
  connector: { id: string; name: string };
}

export async function createConnector(
  opts: CreateConnectorOpts,
): Promise<{ id: string; name: string }> {
  const body: Record<string, unknown> = {
    name: opts.name,
    type: 'kubernetes',
    config: { mode: opts.mode ?? 'in-cluster' },
    allowedNamespaces: opts.allowedNamespaces ?? [],
    capabilities: opts.capabilities ?? ['read'],
  };
  if (opts.manual) body['manual'] = opts.manual;
  if (opts.secret) body['secret'] = opts.secret;
  const created = await apiPost<CreateConnectorResponse>('/api/ops/connectors', body);
  return created.connector;
}

export async function deleteConnector(id: string): Promise<void> {
  try {
    await apiDelete(`/api/ops/connectors/${id}`);
  } catch {
    /* best effort */
  }
}
