import type { GatewayStores } from './types.js';
/** Create a set of in-memory stores (default mode, no external dependencies). */
export declare function createInMemoryStores(): GatewayStores;
/**
 * Return the module-level singleton stores.
 * Used by server.ts so that the proactive pipeline and route handlers share
 * the same store instances (same as before this migration).
 */
export declare function createDefaultStores(): GatewayStores;
//# sourceMappingURL=factory.d.ts.map
