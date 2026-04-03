/**
 * AsyncLocalStorage-based correlation context for propagating requestId
 * through the async call chain without explicit parameter passing.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
export const correlationStore = new AsyncLocalStorage();
/** Returns the current requestId from the async context, if any. */
export function getRequestId() {
    return correlationStore.getStore()?.requestId;
}
//# sourceMappingURL=correlation.js.map