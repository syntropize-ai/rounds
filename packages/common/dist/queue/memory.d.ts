import type { IWorkerQueue, JobOptions, JobHandler, QueueStats } from './interface.js';
export declare class InMemoryWorkerQueue implements IWorkerQueue {
    private readonly queues;
    private readonly handlers;
    private readonly stats;
    private closed;
    enqueue<T>(queueName: string, data: T, opts?: JobOptions): Promise<string>;
    process<T>(queueName: string, handler: JobHandler<T>): () => Promise<void>;
    getStats(queueName: string): Promise<QueueStats>;
    close(): Promise<void>;
    private initStat;
    private incrementStat;
}
//# sourceMappingURL=memory.d.ts.map