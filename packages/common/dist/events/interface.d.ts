import type { EventEnvelope } from './types.js';
export type EventHandler<T = unknown> = (event: EventEnvelope<T>) => void | Promise<void>;
export interface IEventBus {
    /**
     * Publish an event to the given topic.
     * Resolves once the event has been dispatched (not necessarily processed).
     */
    publish<T>(topic: string, event: EventEnvelope<T>): Promise<void>;
    /**
     * Subscribe to events on the given topic.
     * Returns an unsubscribe function.
     */
    subscribe<T>(topic: string, handler: EventHandler<T>): () => void;
    /**
     * Close the bus and release any underlying resources (connections, streams).
     */
    close(): Promise<void>;
}
//# sourceMappingURL=interface.d.ts.map