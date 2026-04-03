import type { ExecutionAdapter, AdapterCapability } from './types.js';
export declare class AdapterRegistry {
    private readonly adapters;
    register(adapter: ExecutionAdapter): void;
    getByCapability(capability: AdapterCapability): ExecutionAdapter[];
    getAll(): ExecutionAdapter[];
}
//# sourceMappingURL=adapter-registry.d.ts.map