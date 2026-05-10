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

export interface KubeconfigMetadata {
  apiServer?: string;
  clusterName?: string;
  context?: string;
  serverIsLocalhost: boolean;
  unreachableFromGateway: boolean;
}

interface ParsedKubeconfigCluster {
  name?: string;
  server?: string;
}

interface ParsedKubeconfigContext {
  name?: string;
  cluster?: string;
}

function stripYamlComment(value: string): string {
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < value.length; i += 1) {
    const ch = value[i];
    if ((ch === '"' || ch === "'") && (i === 0 || value[i - 1] !== '\\')) {
      quote = quote === ch ? null : quote ?? ch;
      continue;
    }
    if (ch === '#' && quote === null && (i === 0 || /\s/.test(value[i - 1] ?? ''))) {
      return value.slice(0, i).trim();
    }
  }
  return value.trim();
}

function parseYamlScalar(value: string): string | undefined {
  const trimmed = stripYamlComment(value).trim();
  if (!trimmed) return undefined;
  const quote = trimmed[0];
  if ((quote === '"' || quote === "'") && trimmed.endsWith(quote)) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

function readYamlKey(line: string, key: string): string | undefined {
  const match = line.match(new RegExp(`^\\s*${key}:\\s*(.*)$`));
  return match ? parseYamlScalar(match[1] ?? '') : undefined;
}

export function isLocalhostApiServer(server: string | undefined): boolean {
  if (!server) return false;
  let host = server.trim();
  try {
    host = new URL(host).hostname;
  } catch {
    // Some pasted values are bare hosts. Match those directly.
  }
  host = host.toLowerCase().replace(/^\[|\]$/g, '');
  return host === '127.0.0.1'
    || host === 'localhost'
    || host === '::1'
    || host === 'host.docker.internal';
}

export function inspectKubeconfigMetadata(yaml: string): KubeconfigMetadata {
  const clusters: ParsedKubeconfigCluster[] = [];
  const contexts: ParsedKubeconfigContext[] = [];
  let currentContext: string | undefined;
  let section: 'clusters' | 'contexts' | undefined;
  let activeCluster: ParsedKubeconfigCluster | undefined;
  let activeContext: ParsedKubeconfigContext | undefined;

  for (const rawLine of yaml.split(/\r?\n/)) {
    if (!rawLine.trim() || rawLine.trimStart().startsWith('#')) continue;

    const topLevel = rawLine.match(/^([A-Za-z][\w-]*):\s*(.*)$/);
    if (topLevel) {
      activeCluster = undefined;
      activeContext = undefined;
      if (topLevel[1] === 'current-context') {
        currentContext = parseYamlScalar(topLevel[2] ?? '');
      }
      section = topLevel[1] === 'clusters' || topLevel[1] === 'contexts'
        ? topLevel[1]
        : undefined;
      continue;
    }

    const listItem = rawLine.match(/^\s*-\s*(.*)$/);
    if (listItem) {
      if (section === 'clusters') {
        activeCluster = {};
        activeContext = undefined;
        clusters.push(activeCluster);
        const name = readYamlKey(listItem[1] ?? '', 'name');
        if (name) activeCluster.name = name;
      } else if (section === 'contexts') {
        activeContext = {};
        activeCluster = undefined;
        contexts.push(activeContext);
        const name = readYamlKey(listItem[1] ?? '', 'name');
        if (name) activeContext.name = name;
      }
      continue;
    }

    if (section === 'clusters' && activeCluster) {
      const name = readYamlKey(rawLine, 'name');
      if (name) activeCluster.name = name;
      const server = readYamlKey(rawLine, 'server');
      if (server) activeCluster.server = server;
    } else if (section === 'contexts' && activeContext) {
      const name = readYamlKey(rawLine, 'name');
      if (name) activeContext.name = name;
      const cluster = readYamlKey(rawLine, 'cluster');
      if (cluster) activeContext.cluster = cluster;
    }
  }

  const selectedContext = contexts.find((ctx) => ctx.name === currentContext) ?? contexts[0];
  const selectedClusterName = selectedContext?.cluster ?? clusters[0]?.name;
  const selectedCluster = clusters.find((cluster) => cluster.name === selectedClusterName) ?? clusters[0];
  const apiServer = selectedCluster?.server;
  const context = currentContext ?? selectedContext?.name;
  const serverIsLocalhost = isLocalhostApiServer(apiServer);

  return {
    ...(apiServer ? { apiServer } : {}),
    ...(selectedCluster?.name ? { clusterName: selectedCluster.name } : {}),
    ...(context ? { context } : {}),
    serverIsLocalhost,
    unreachableFromGateway: serverIsLocalhost,
  };
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
    const res = await apiClient.get<{ connectors?: OpsConnector[] } | OpsConnector[]>('/connectors');
    if (res.error) throw new Error(res.error.message ?? 'Failed to load Ops connectors');
    if (Array.isArray(res.data)) return res.data;
    return res.data?.connectors ?? [];
  },

  async createConnector(input: OpsConnectorInput): Promise<OpsConnector> {
    const res = await apiClient.post<{ connector?: OpsConnector } | OpsConnector>('/connectors', input);
    if (res.error) throw new Error(res.error.message ?? 'Failed to create Ops connector');
    if ('connector' in res.data && res.data.connector) return res.data.connector;
    return res.data as OpsConnector;
  },

  async testConnector(id: string): Promise<OpsConnectorTestResult> {
    const res = await apiClient.post<OpsConnectorTestResult>(`/connectors/${encodeURIComponent(id)}/test`, {});
    if (res.error) throw new Error(res.error.message ?? 'Failed to test Ops connector');
    return res.data;
  },

  async deleteConnector(id: string): Promise<void> {
    const res = await apiClient.delete<{ ok: boolean }>(`/connectors/${encodeURIComponent(id)}`);
    if (res.error) throw new Error(res.error.message ?? 'Failed to delete Ops connector');
  },
};
