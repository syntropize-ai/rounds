/**
 * AsyncLocalStorage-based correlation context for propagating requestId
 * through the async call chain without explicit parameter passing.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
export interface CorrelationContext {
    requestId: string;
}
export declare const correlationStore: AsyncLocalStorage<CorrelationContext>;
/** Returns the current requestId from the async context, if any. */
export declare function getRequestId(): string | undefined;
//# sourceMappingURL=correlation.d.ts.map