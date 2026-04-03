import type { IEventBus, EventHandler } from './interface.js';
import type { EventEnvelope } from './types.js';
export declare class InMemoryEventBus implements IEventBus {
    private readonly emitter;
    constructor();
    publish<T>(topic: string, event: EventEnvelope<T>): Promise<void>;
    subscribe<T>(topic: string, handler: EventHandler<T>): () => void;
    close(): Promise<void>;
}
//# sourceMappingURL=memory.d.ts.map