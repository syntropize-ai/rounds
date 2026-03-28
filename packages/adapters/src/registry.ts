// AdapterRegistry - register, discover, and health-check data adapters

import type { DataAdapter } from './adapter.js';
import type { AdapterHealth, SignalType } from './types.js';

export interface AdapterRegistration {
  adapter: DataAdapter;
  registeredAt: string;
  lastHealth?: AdapterHealth;
}

export class AdapterRegistry {
  private readonly adapters = new Map<string, AdapterRegistration>();

  /** Register an adapter. Throws if an adapter with the same name already exists. */
  register(adapter: DataAdapter): void {
    if (this.adapters.has(adapter.name)) {
      throw new Error(`Adapter '${adapter.name}' is already registered`);
    }
    this.adapters.set(adapter.name, {
      adapter,
      registeredAt: new Date().toISOString(),
    });
  }

  /** Unregister an adapter by name. */
  unregister(name: string): boolean {
    return this.adapters.delete(name);
  }

  /** Retrieve an adapter by name. Returns undefined if not found. */
  get(name: string): DataAdapter | undefined {
    return this.adapters.get(name)?.adapter;
  }

  /** Return all registered adapters. */
  list(): DataAdapter[] {
    return Array.from(this.adapters.values()).map((r) => r.adapter);
  }

  /**
   * Discover adapters that can serve the given signal type.
   * Only returns adapters whose Capabilities declare support for it.
   */
  findBySignalType(signalType: SignalType): DataAdapter[] {
    return this.list().filter((adapter) =>
      adapter.meta().supportedSignalTypes.includes(signalType),
    );
  }

  /** Discover adapters that expose a given semantic metric name. */
  findByMetric(metricName: string): DataAdapter[] {
    return this.list().filter((adapter) =>
      adapter.meta().supportedMetrics.includes(metricName),
    );
  }

  /**
   * Run health checks on all registered adapters and cache results.
   * Returns a map of adapter name -> health status.
   */
  async healthCheckAll(): Promise<Map<string, AdapterHealth>> {
    const results = new Map<string, AdapterHealth>();

    await Promise.all(
      Array.from(this.adapters.entries()).map(async ([name, registration]) => {
        try {
          const health = await registration.adapter.healthCheck();
          registration.lastHealth = health;
          results.set(name, health);
        } catch (err) {
          const health: AdapterHealth = {
            status: 'unavailable',
            message: err instanceof Error ? err.message : String(err),
            checkedAt: new Date().toISOString(),
          };
          registration.lastHealth = health;
          results.set(name, health);
        }
      }),
    );

    return results;
  }

  /**
   * Return the last cached health status for a named adapter.
   * Returns undefined if no health check has been performed yet.
   */
  getLastHealth(name: string): AdapterHealth | undefined {
    return this.adapters.get(name)?.lastHealth;
  }

  /** Return only healthy adapters from the registry. */
  listHealthy(): DataAdapter[] {
    return Array.from(this.adapters.values())
      .filter((r) => r.lastHealth?.status === 'healthy')
      .map((r) => r.adapter);
  }
}