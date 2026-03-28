import type { ExecutionAdapter, AdapterCapability } from './types.js';

export class AdapterRegistry {
  private readonly adapters: ExecutionAdapter[] = [];

  register(adapter: ExecutionAdapter): void {
    this.adapters.push(adapter);
  }

  getByCapability(capability: AdapterCapability): ExecutionAdapter[] {
    return this.adapters.filter((a) => a.capabilities().includes(capability));
  }

  getAll(): ExecutionAdapter[] {
    return [...this.adapters];
  }
}
