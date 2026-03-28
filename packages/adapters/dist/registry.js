// AdapterRegistry - register, discover, and health-check data adapters
export class AdapterRegistry {
  adapters = new Map();

  /** Register an adapter. Throws if an adapter with the same name already exists. */
  register(adapter) {
    if (this.adapters.has(adapter.name)) {
      throw new Error(`Adapter '${adapter.name}' is already registered`);
    }
    this.adapters.set(adapter.name, {
      adapter,
      registeredAt: new Date().toISOString(),
    });
  }

  /** Unregister an adapter by name. */
  unregister(name) {
    return this.adapters.delete(name);
  }

  /** Retrieve an adapter by name. Returns undefined if not found. */
  get(name) {
    return this.adapters.get(name)?.adapter;
  }

  /** Return all registered adapters. */
  list() {
    return Array.from(this.adapters.values()).map((r) => r.adapter);
  }

  /** Discover adapters that can serve the given signal type. */
  findBySignalType(signalType) {
    return this.list().filter((adapter) => 
      adapter.meta().supportedSignalTypes.includes(signalType)
    );
  }

  /** Discover adapters that expose a given semantic metric name. */
  findByMetric(metricName) {
    return this.list().filter((adapter) => 
      adapter.meta().supportedMetrics.includes(metricName)
    );
  }

  /** Run health checks on all registered adapters and cache results. */
  async healthCheckAll() {
    const results = new Map();
    await Promise.all(Array.from(this.adapters.entries()).map(async ([name, registration]) => {
      try {
        const health = await registration.adapter.healthCheck();
        registration.lastHealth = health;
        results.set(name, health);
      } catch (err) {
        const health = {
          status: 'unavailable',
          message: err instanceof Error ? err.message : String(err),
          checkedAt: new Date().toISOString(),
        };
        registration.lastHealth = health;
        results.set(name, health);
      }
    }));
    return results;
  }

  /** Return the last cached health status for a named adapter. */
  getLastHealth(name) {
    return this.adapters.get(name)?.lastHealth;
  }

  /** Return only healthy adapters from the registry. */
  listHealthy() {
    return Array.from(this.adapters.values())
      .filter((r) => r.lastHealth?.status === 'healthy')
      .map((r) => r.adapter);
  }
}