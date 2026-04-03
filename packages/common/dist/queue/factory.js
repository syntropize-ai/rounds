// WorkerQueueFactory - selects BullMQ or InMemory implementation based on config
import { InMemoryWorkerQueue } from './memory.js';
import { BullMQWorkerQueue } from './bullmq.js';
export function createWorkerQueue(config = { backend: 'memory' }) {
    if (config.backend === 'bullmq') {
        return new BullMQWorkerQueue(config.bullmq ?? {});
    }
    return new InMemoryWorkerQueue();
}
/**
 * Convenience factory that reads REDIS_URL from the environment.
 * Falls back to InMemoryWorkerQueue when REDIS_URL is not set.
 */
export function createWorkerQueueFromEnv() {
    const redisUrl = process.env['REDIS_URL'];
    if (redisUrl) {
        return new BullMQWorkerQueue({ url: redisUrl });
    }
    return new InMemoryWorkerQueue();
}
//# sourceMappingURL=factory.js.map