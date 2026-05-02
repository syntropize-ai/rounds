import type { InstanceDatasource } from '@agentic-obs/common';
import { AdapterRegistry } from '@agentic-obs/agent-core';
import { PrometheusMetricsAdapter, LokiLogsAdapter } from '@agentic-obs/adapters';
import type { IChangesAdapter } from '@agentic-obs/adapters';

/**
 * Convert InstanceDatasource[] to the narrower `DatasourceConfig[]`
 * shape the orchestrator's system-prompt helpers expect. Drops credential
 * fields (they don't belong in a prompt) and converts `null` → undefined.
 */
export function toAgentDatasources(datasources: InstanceDatasource[]): Array<{
  id: string;
  type: string;
  name: string;
  url: string;
  environment?: string;
  cluster?: string;
  label?: string;
  isDefault?: boolean;
}> {
  return datasources.map((d) => ({
    id: d.id,
    type: d.type,
    name: d.name,
    url: d.url,
    ...(d.environment ? { environment: d.environment } : {}),
    ...(d.cluster ? { cluster: d.cluster } : {}),
    ...(d.label ? { label: d.label } : {}),
    isDefault: d.isDefault,
  }));
}

// -- Prometheus resolution (shared across services)

export interface PrometheusDatasource {
  url: string;
  headers: Record<string, string>;
}

export function resolvePrometheusDatasource(datasources: InstanceDatasource[]): PrometheusDatasource | undefined {
  const promDatasources = datasources.filter((d) => d.type === 'prometheus' || d.type === 'victoria-metrics');
  const prom = promDatasources.find((d) => d.isDefault) ?? promDatasources[0];
  if (!prom) return undefined;

  const headers: Record<string, string> = {};
  if (prom.username && prom.password) {
    headers.Authorization = `Basic ${Buffer.from(`${prom.username}:${prom.password}`).toString('base64')}`;
  } else if (prom.apiKey) {
    headers.Authorization = `Bearer ${prom.apiKey}`;
  }

  return { url: prom.url, headers };
}

/** Build HTTP auth headers from an InstanceDatasource's stored credentials. */
export function datasourceHeaders(ds: InstanceDatasource): Record<string, string> {
  const headers: Record<string, string> = {};
  if (ds.username && ds.password) {
    headers.Authorization = `Basic ${Buffer.from(`${ds.username}:${ds.password}`).toString('base64')}`;
  } else if (ds.apiKey) {
    headers.Authorization = `Bearer ${ds.apiKey}`;
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
  datasources: InstanceDatasource[],
  changeAdapters: ChangeAdapterRegistration[] = [],
): AdapterRegistry {
  const registry = new AdapterRegistry();
  for (const ds of datasources) {
    const headers = datasourceHeaders(ds);
    if (ds.type === 'prometheus' || ds.type === 'victoria-metrics') {
      registry.register({
        info: { id: ds.id, name: ds.name, type: ds.type, url: ds.url, signalType: 'metrics', isDefault: ds.isDefault },
        metrics: new PrometheusMetricsAdapter(ds.url, headers),
      });
    } else if (ds.type === 'loki') {
      registry.register({
        info: { id: ds.id, name: ds.name, type: ds.type, url: ds.url, signalType: 'logs', isDefault: ds.isDefault },
        logs: new LokiLogsAdapter(ds.url, headers),
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
