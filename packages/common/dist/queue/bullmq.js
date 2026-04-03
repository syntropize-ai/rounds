// BullMQWorkerQueue - Redis-backed queue using BullMQ
//
// Each queue name maps to a separate BullMQ Queue + Worker pair.
// Dead-letter handling: failed jobs (exhausted retries) remain in the
// BullMQ "failed" set and are reflected in getStats().
import { Queue, Worker } from 'bullmq';
function parseConnection(opts) {
    if (opts.connection)
        return opts.connection;
    const url = new URL(opts.url ?? 'redis://localhost:6379');
    return {
        host: url.hostname,
        port: Number(url.port) || 6379,
        password: url.password || undefined,
        db: url.pathname ? Number(url.pathname.slice(1)) || 0 : 0,
    };
}
export class BullMQWorkerQueue {
    connection;
    defaultAttempts;
    managed = new Map();
    constructor(opts = {}) {
        this.connection = parseConnection(opts);
        this.defaultAttempts = opts.defaultAttempts ?? 3;
    }
    async enqueue(queueName, data, opts = {}) {
        const managed = this.getOrCreateQueue(queueName);
        const job = await managed.queue.add(queueName, data, {
            attempts: opts.attempts ?? this.defaultAttempts,
            delay: opts.delay,
            priority: opts.priority,
            backoff: opts.backoff
                ? { type: opts.backoff.type, delay: opts.backoff.delay }
                : { type: 'exponential', delay: 1000 },
        });
        return job.id ?? '';
    }
    process(queueName, handler) {
        const managed = this.getOrCreateQueue(queueName);
        const worker = new Worker(queueName, async (job) => {
            const record = {
                id: job.id ?? '',
                name: job.name,
                data: job.data,
                attempts: job.attemptsMade,
                createdAt: new Date(job.timestamp).toISOString(),
            };
            await handler(record);
        }, { connection: this.connection });
        managed.workers.push(worker);
        return async () => {
            const idx = managed.workers.indexOf(worker);
            if (idx !== -1)
                managed.workers.splice(idx, 1);
            await worker.close();
        };
    }
    async getStats(queueName) {
        const managed = this.managed.get(queueName);
        if (!managed)
            return { waiting: 0, active: 0, completed: 0, failed: 0 };
        const [waiting, active, completed, failed] = await Promise.all([
            managed.queue.getWaitingCount(),
            managed.queue.getActiveCount(),
            managed.queue.getCompletedCount(),
            managed.queue.getFailedCount(),
        ]);
        return { waiting, active, completed, failed };
    }
    async close() {
        await Promise.all(Array.from(this.managed.values()).flatMap(({ queue, workers }) => [
            queue.close(),
            ...workers.map((w) => w.close()),
        ]));
        this.managed.clear();
    }
    getOrCreateQueue(queueName) {
        if (!this.managed.has(queueName)) {
            this.managed.set(queueName, {
                queue: new Queue(queueName, { connection: this.connection }),
                workers: [],
            });
        }
        return this.managed.get(queueName);
    }
}
//# sourceMappingURL=bullmq.js.map