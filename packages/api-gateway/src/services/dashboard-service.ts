import type { Connector } from '@agentic-obs/common';
import { AdapterRegistry } from '@agentic-obs/agent-core';
import { PrometheusMetricsAdapter, LokiLogsAdapter } from '@agentic-obs/adapters';
import type { IChangesAdapter } from '@agentic-obs/adapters';

/**
 * Convert Connector[] to the narrower prompt config shape
 * shape the orchestrator's system-prompt helpers expect. Drops credential
 * fields (they don't belong in a prompt) and converts `null` → undefined.
 */
export function toAgentConnectors(connectors: Connector[]): Array<{
  id: string;
  type: string;
  name: string;
  url: string;
  environment?: string;
  cluster?: string;
  label?: string;
  isDefault?: boolean;
}> {
  return connectors.map((c) => ({
    id: c.id,
    type: c.type,
    name: c.name,
    url: configString(c, 'url') ?? '',
    ...(configString(c, 'environment') ? { environment: configString(c, 'environment') } : {}),
    ...(configString(c, 'cluster') ? { cluster: configString(c, 'cluster') } : {}),
    ...(configString(c, 'label') ? { label: configString(c, 'label') } : {}),
    isDefault: c.isDefault,
  }));
}

// -- Prometheus resolution (shared across services)

export interface PrometheusConnector {
  url: string;
  headers: Record<string, string>;
}

export function resolvePrometheusConnector(connectors: Connector[]): PrometheusConnector | undefined {
  const promConnectors = connectors.filter((c) => c.type === 'prometheus' || c.type === 'victoria-metrics');
  const prom = promConnectors.find((c) => c.isDefault) ?? promConnectors[0];
  if (!prom) return undefined;

  return { url: configString(prom, 'url') ?? '', headers: connectorHeaders(prom) };
}

function configString(connector: Connector, key: string): string | undefined {
  const value = connector.config[key];
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

/** Build HTTP auth headers from connector config. Real secrets are resolved at adapter boundary. */
export function connectorHeaders(connector: Connector): Record<string, string> {
  const headers: Record<string, string> = {};
  const username = configString(connector, 'username');
  const password = configString(connector, 'password');
  const apiKey = configString(connector, 'apiKey');
  if (username && password) {
    headers.Authorization = `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;
  } else if (apiKey) {
    headers.Authorization = `Bearer ${apiKey}`;
  }
  return headers;
}

/**
 * Build an AdapterRegistry from the user's configured datasources.
 *
 * Each recognized datasource type is instantiated with the appropriate
 * backend adapter class and registered under its `id`. Unrecognized types
 * are skipped silently (the setup wizard may let users save types that
 * we don't have an adapter for yet; those just won't be queryable by the
 * agent until an adapter lands).
 */
export interface ChangeAdapterRegistration {
  id: string;
  name: string;
  adapter: IChangesAdapter;
}

export function buildAdapterRegistry(
  connectors: Connector[],
  changeAdapters: ChangeAdapterRegistration[] = [],
): AdapterRegistry {
  const registry = new AdapterRegistry();
  for (const connector of connectors) {
    const url = configString(connector, 'url') ?? '';
    const headers = connectorHeaders(connector);
    if (connector.type === 'prometheus' || connector.type === 'victoria-metrics') {
      registry.register({
        info: { id: connector.id, name: connector.name, type: connector.type, url, signalType: 'metrics', isDefault: connector.isDefault },
        metrics: new PrometheusMetricsAdapter(url, headers),
      });
    } else if (connector.type === 'loki') {
      registry.register({
        info: { id: connector.id, name: connector.name, type: connector.type, url, signalType: 'logs', isDefault: connector.isDefault },
        logs: new LokiLogsAdapter(url, headers),
      });
    }
    // elasticsearch / clickhouse / tempo / jaeger / otel: adapters not yet implemented
  }
  for (const source of changeAdapters) {
    registry.register({
      info: { id: source.id, name: source.name, type: 'github', signalType: 'changes' },
      changes: source.adapter,
    });
  }
  return registry;
}

// -- Dashboard lock (prevents concurrent mutations on same dashboard)

const dashboardLocks = new Map<string, Promise<void>>();

export async function withDashboardLock<T>(dashboardId: string, fn: () => Promise<T>): Promise<T> {
  let resolve: () => void;
  const next = new Promise<void>((r) => { resolve = r; });
  const wait = dashboardLocks.get(dashboardId) ?? Promise.resolve();
  dashboardLocks.set(dashboardId, next);
  await wait;
  try {
    return await fn();
  } finally {
    resolve!();
    if (dashboardLocks.get(dashboardId) === next) {
      dashboardLocks.delete(dashboardId);
    }
  }
}
