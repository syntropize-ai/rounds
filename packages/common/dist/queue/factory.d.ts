import type { IWorkerQueue } from './interface.js';
import type { BullMQWorkerQueueOptions } from './bullmq.js';
export type WorkerQueueBackend = 'memory' | 'bullmq';
export interface WorkerQueueConfig {
    backend: WorkerQueueBackend;
    bullmq?: BullMQWorkerQueueOptions;
}
export declare function createWorkerQueue(config?: WorkerQueueConfig): IWorkerQueue;
/**
 * Convenience factory that reads REDIS_URL from the environment.
 * Falls back to InMemoryWorkerQueue when REDIS_URL is not set.
 */
export declare function createWorkerQueueFromEnv(): IWorkerQueue;
//# sourceMappingURL=factory.d.ts.map