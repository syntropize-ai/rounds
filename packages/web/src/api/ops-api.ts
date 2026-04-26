import { apiClient } from './rest-api.js';

export type OpsCapability = 'read' | 'propose' | 'execute_approved';

export interface OpsConnector {
  id: string;
  name: string;
  environment?: string | null;
  config?: {
    apiServer?: string;
    clusterName?: string;
    context?: string;
    credentialType?: 'kubeconfig' | 'token';
  };
  allowedNamespaces: string[];
  capabilities: OpsCapability[];
  status?: 'unknown' | 'connected' | 'degraded' | 'error';
  lastCheckedAt?: string | null;
}

export interface OpsConnectorTestResult {
  status: 'connected' | 'degraded' | 'error';
  message: string;
  checks?: Record<string, string>;
}

export interface OpsConnectorInput {
  name: string;
  environment?: string | null;
  config: {
    apiServer?: string;
    clusterName?: string;
    context?: string;
    credentialType?: 'kubeconfig' | 'token';
  };
  allowedNamespaces: string[];
  secretRef?: string | null;
  secret?: string | null;
  capabilities: OpsCapability[];
}

export function parseNamespaceList(value: string): string[] {
  return value
    .split(/[\n,]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

export function buildOpsConnectorInput(value: {
  name: string;
  environment: string;
  apiServer: string;
  clusterName: string;
  context: string;
  namespaces: string;
  kubeconfig: string;
  token: string;
  secretRef: string;
  capabilities: Record<OpsCapability, boolean>;
}): OpsConnectorInput {
  const secret = value.kubeconfig.trim() || value.token.trim() || null;
  const secretRef = value.secretRef.trim() || null;
  return {
    name: value.name.trim(),
    environment: value.environment.trim() || null,
    config: {
      apiServer: value.apiServer.trim() || undefined,
      clusterName: value.clusterName.trim() || undefined,
      context: value.context.trim() || undefined,
      credentialType: value.kubeconfig.trim() ? 'kubeconfig' : (value.token.trim() ? 'token' : undefined),
    },
    allowedNamespaces: parseNamespaceList(value.namespaces),
    secretRef,
    secret: secretRef ? null : secret,
    capabilities: (Object.keys(value.capabilities) as OpsCapability[])
      .filter((capability) => value.capabilities[capability]),
  };
}

export const opsApi = {
  async listConnectors(): Promise<OpsConnector[]> {
    const res = await apiClient.get<{ connectors?: OpsConnector[] } | OpsConnector[]>('/ops/connectors');
    if (res.error) throw new Error(res.error.message ?? 'Failed to load Ops connectors');
    if (Array.isArray(res.data)) return res.data;
    return res.data?.connectors ?? [];
  },

  async createConnector(input: OpsConnectorInput): Promise<OpsConnector> {
    const res = await apiClient.post<{ connector?: OpsConnector } | OpsConnector>('/ops/connectors', input);
    if (res.error) throw new Error(res.error.message ?? 'Failed to create Ops connector');
    if ('connector' in res.data && res.data.connector) return res.data.connector;
    return res.data as OpsConnector;
  },

  async testConnector(id: string): Promise<OpsConnectorTestResult> {
    const res = await apiClient.post<OpsConnectorTestResult>(`/ops/connectors/${encodeURIComponent(id)}/test`, {});
    if (res.error) throw new Error(res.error.message ?? 'Failed to test Ops connector');
    return res.data;
  },

  async deleteConnector(id: string): Promise<void> {
    const res = await apiClient.delete<{ ok: boolean }>(`/ops/connectors/${encodeURIComponent(id)}`);
    if (res.error) throw new Error(res.error.message ?? 'Failed to delete Ops connector');
  },
};
