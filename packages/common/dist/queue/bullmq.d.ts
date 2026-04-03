import { type ConnectionOptions } from 'bullmq';
import type { IWorkerQueue, JobOptions, JobHandler, QueueStats } from './interface.js';
export interface BullMQWorkerQueueOptions {
    /** Redis connection URL, e.g. redis://localhost:6379 */
    url?: string;
    /** Pre-built ioredis ConnectionOptions (takes precedence over url) */
    connection?: ConnectionOptions;
    /** Default number of job attempts (default 3) */
    defaultAttempts?: number;
}
export declare class BullMQWorkerQueue implements IWorkerQueue {
    private readonly connection;
    private readonly defaultAttempts;
    private readonly managed;
    constructor(opts?: BullMQWorkerQueueOptions);
    enqueue<T>(queueName: string, data: T, opts?: JobOptions): Promise<string>;
    process<T>(queueName: string, handler: JobHandler<T>): () => Promise<void>;
    getStats(queueName: string): Promise<QueueStats>;
    close(): Promise<void>;
    private getOrCreateQueue;
}
//# sourceMappingURL=bullmq.d.ts.map