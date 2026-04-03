export interface JobOptions {
    /** Delay before the job becomes eligible (ms) */
    delay?: number;
    /** Number of attempts before moving to DLQ (default 3) */
    attempts?: number;
    /** Exponential backoff config */
    backoff?: {
        type: 'exponential' | 'fixed';
        delay: number;
    };
    /** Job priority (lower = higher priority) */
    priority?: number;
}
export interface JobRecord<T = unknown> {
    id: string;
    name: string;
    data: T;
    attempts: number;
    createdAt: string;
}
export interface QueueStats {
    waiting: number;
    active: number;
    completed: number;
    failed: number;
}
export type JobHandler<T = unknown> = (job: JobRecord<T>) => Promise<void>;
export interface IWorkerQueue {
    /**
     * Add a job to the named queue.
     * Resolves with the assigned job ID.
     */
    enqueue<T>(queueName: string, data: T, opts?: JobOptions): Promise<string>;
    /**
     * Register a handler for jobs on the named queue.
     * Returns an unregister function.
     */
    process<T>(queueName: string, handler: JobHandler<T>): () => Promise<void>;
    /** Get current queue statistics. */
    getStats(queueName: string): Promise<QueueStats>;
    /**
     * Gracefully shut down - drain active jobs and close connections.
     */
    close(): Promise<void>;
}
//# sourceMappingURL=interface.d.ts.map