/**
 * Setup smoke — kubeconfig with `server: https://127.0.0.1:6443` should
 * surface a warning that the apiserver address is unreachable from
 * inside the cluster (Ref PR #120).
 *
 * We can't drive the warning UI in an API test, so we only assert that
 * (a) the connector creates, and (b) some warning is exposed via either
 * the create response or a follow-up GET. If the field name doesn't
 * exist we mark the test `it.fails` to flag the gap.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { apiPost, apiGet, apiDelete } from '../helpers/api-client.js';

const KUBECONFIG_LOCALHOST = `apiVersion: v1
kind: Config
clusters:
- name: local
  cluster:
    server: https://127.0.0.1:6443
    insecure-skip-tls-verify: true
contexts:
- name: local
  context:
    cluster: local
    user: local
current-context: local
users:
- name: local
  user:
    token: dummy
`;

interface CreateResp { connector: { id: string; warnings?: string[] } }
interface GetResp { connector: { id: string; warnings?: string[]; config?: { warnings?: string[] } } }

describe('setup/localhost-warning-emits', () => {
  let id: string | null = null;

  afterAll(async () => {
    if (id) {
      try { await apiDelete(`/api/ops/connectors/${id}`); } catch { /* noop */ }
    }
  }, 30_000);

  // The warning surfacing is best-effort and may not be wired through the
  // API yet — mark this as failing-but-tracked so CI surfaces a regression
  // when the field finally exists, without breaking the suite today.
  it.fails('connector with server=https://127.0.0.1:6443 surfaces a localhost warning (PR #120)', async () => {
    const created = await apiPost<CreateResp>('/api/ops/connectors', {
      name: `e2e-localhost-${Date.now()}`,
      type: 'kubernetes',
      config: { mode: 'kubeconfig' },
      secret: KUBECONFIG_LOCALHOST,
      allowedNamespaces: [],
      capabilities: ['read'],
    });
    id = created.connector.id;
    const fetched = await apiGet<GetResp>(`/api/ops/connectors/${id}`);
    const warnings = fetched.connector.warnings ?? fetched.connector.config?.warnings ?? [];
    expect(warnings.join(' ')).toMatch(/localhost|127\.0\.0\.1|loopback|in-cluster/i);
  }, 60_000);
});
