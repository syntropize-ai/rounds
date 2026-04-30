import { apiClient } from './rest-api.js';

export type OpsCapability = 'read' | 'propose' | 'execute_approved';

export type OpsConnectorMode = 'in-cluster' | 'kubeconfig' | 'manual';

export interface OpsConnector {
  id: string;
  name: string;
  environment?: string | null;
  config?: {
    apiServer?: string;
    clusterName?: string;
    context?: string;
    credentialType?: 'kubeconfig' | 'token';
    mode?: OpsConnectorMode;
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
    mode?: OpsConnectorMode;
  };
  allowedNamespaces: string[];
  secretRef?: string | null;
  secret?: string | null;
  /** Manual-mode credentials. Backend synthesizes the kubeconfig from these. */
  manual?: {
    server: string;
    token: string;
    caData?: string;
    insecureSkipTlsVerify?: boolean;
  };
  capabilities: OpsCapability[];
}

export function parseNamespaceList(value: string): string[] {
  return value
    .split(/[\n,]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

export interface OpsConnectorFormValue {
  mode: OpsConnectorMode;
  name: string;
  environment: string;
  clusterName: string;
  namespaces: string;
  // kubeconfig-mode field
  kubeconfig: string;
  context: string;
  // manual-mode fields
  apiServer: string;
  token: string;
  caData: string;
  insecureSkipTlsVerify: boolean;
  capabilities: Record<OpsCapability, boolean>;
}

export function buildOpsConnectorInput(value: OpsConnectorFormValue): OpsConnectorInput {
  const allowedNamespaces = parseNamespaceList(value.namespaces);
  const capabilities = (Object.keys(value.capabilities) as OpsCapability[])
    .filter((capability) => value.capabilities[capability]);
  const baseConfig = {
    clusterName: value.clusterName.trim() || undefined,
    mode: value.mode,
  };
  const common = {
    name: value.name.trim(),
    environment: value.environment.trim() || null,
    allowedNamespaces,
    capabilities,
  };

  if (value.mode === 'in-cluster') {
    return {
      ...common,
      config: { ...baseConfig },
      secret: null,
      secretRef: null,
    };
  }

  if (value.mode === 'manual') {
    return {
      ...common,
      config: {
        ...baseConfig,
        apiServer: value.apiServer.trim() || undefined,
        credentialType: 'token',
      },
      manual: {
        server: value.apiServer.trim(),
        token: value.token.trim(),
        caData: value.caData.trim() || undefined,
        insecureSkipTlsVerify: value.insecureSkipTlsVerify || undefined,
      },
      secret: null,
      secretRef: null,
    };
  }

  // kubeconfig
  return {
    ...common,
    config: {
      ...baseConfig,
      context: value.context.trim() || undefined,
      credentialType: 'kubeconfig',
    },
    secret: value.kubeconfig.trim() || null,
    secretRef: null,
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
