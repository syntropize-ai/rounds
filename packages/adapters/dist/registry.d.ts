import type { DataAdapter } from './adapter.js';
import type { AdapterHealth, SignalType } from './types.js';

export interface AdapterRegistration {
  adapter: DataAdapter;
  registeredAt: string;
  lastHealth?: AdapterHealth;
}

export declare class AdapterRegistry {
  private readonly adapters;
  /** Register an adapter. Throws if an adapter with the same name already exists. */
  register(adapter: DataAdapter): void;
  /** Unregister an adapter by name. */
  unregister(name: string): boolean;
  /** Retrieve an adapter by name. Returns undefined if not found. */
  get(name: string): DataAdapter | undefined;
  /** Return all registered adapters. */
  list(): DataAdapter[];
  /** Discover adapters that can serve the given signal type. */
  findBySignalType(signalType: SignalType): DataAdapter[];
  /** Discover adapters that expose a given semantic metric name. */
  findByMetric(metricName: string): DataAdapter[];
  /** Run health checks on all registered adapters and cache results. */
  healthCheckAll(): Promise<Map<string, AdapterHealth>>;
  /** Return the last cached health status for a named adapter. */
  getLastHealth(name: string): AdapterHealth | undefined;
  /** Return only healthy adapters from the registry. */
  listHealthy(): DataAdapter[];
}