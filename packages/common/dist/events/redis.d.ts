import { Redis } from 'ioredis';
import type { IEventBus, EventHandler } from './interface.js';
import type { EventEnvelope } from './types.js';
export interface RedisEventBusOptions {
    /** ioredis connection URL, e.g. redis://localhost:6379 */
    url?: string;
    /** Pre-created ioredis client (takes precedence over url) */
    client?: Redis;
    /** Consumer group name - defaults to agentic-obs */
    group?: string;
    /** Consumer name - defaults to a random UUID per bus instance */
    consumer?: string;
}
export declare class RedisEventBus implements IEventBus {
    private readonly pub;
    private readonly sub;
    private readonly group;
    private readonly consumer;
    private readonly handlers;
    private readonly streamTasks;
    private closed;
    constructor(opts?: RedisEventBusOptions);
    publish<T>(topic: string, event: EventEnvelope<T>): Promise<void>;
    subscribe<T>(topic: string, handler: EventHandler<T>): () => void;
    close(): Promise<void>;
    private startReading;
}
//# sourceMappingURL=redis.d.ts.map