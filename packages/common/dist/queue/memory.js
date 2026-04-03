// InMemoryWorkerQueue - synchronous, in-process queue for testing
import { randomUUID } from 'crypto';
export class InMemoryWorkerQueue {
    queues = new Map();
    handlers = new Map();
    stats = new Map();
    closed = false;
    async enqueue(queueName, data, opts = {}) {
        const id = randomUUID();
        const record = {
            id,
            name: queueName,
            data,
            attempts: 0,
            createdAt: new Date().toISOString(),
        };
        const job = {
            record,
            opts: { attempts: opts.attempts ?? 3, delay: opts.delay ?? 0 },
        };
        if (!this.queues.has(queueName))
            this.queues.set(queueName, []);
        this.queues.get(queueName).push(job);
        this.incrementStat(queueName, 'waiting', 1);
        // Dispatch asynchronously after optional delay
        const handler = this.handlers.get(queueName);
        if (handler) {
            const dispatch = async () => {
                if (this.closed)
                    return;
                const queue = this.queues.get(queueName);
                const idx = queue?.findIndex((j) => j.record.id === id) ?? -1;
                if (idx === -1)
                    return;
                queue.splice(idx, 1);
                this.incrementStat(queueName, 'waiting', -1);
                this.incrementStat(queueName, 'active', 1);
                try {
                    await handler(record);
                    this.incrementStat(queueName, 'active', -1);
                    this.incrementStat(queueName, 'completed', 1);
                }
                catch {
                    this.incrementStat(queueName, 'active', -1);
                    this.incrementStat(queueName, 'failed', 1);
                }
            };
            if (opts.delay && opts.delay > 0) {
                setTimeout(() => void dispatch(), opts.delay);
            }
            else {
                void dispatch();
            }
        }
        return id;
    }
    process(queueName, handler) {
        this.handlers.set(queueName, handler);
        return async () => {
            this.handlers.delete(queueName);
        };
    }
    async getStats(queueName) {
        return this.stats.get(queueName) ?? { waiting: 0, active: 0, completed: 0, failed: 0 };
    }
    async close() {
        this.closed = true;
        this.handlers.clear();
        this.queues.clear();
    }
    initStat(queueName) {
        if (!this.stats.has(queueName)) {
            this.stats.set(queueName, { waiting: 0, active: 0, completed: 0, failed: 0 });
        }
        return this.stats.get(queueName);
    }
    incrementStat(queueName, key, delta) {
        const s = this.initStat(queueName);
        s[key] = Math.max(0, s[key] + delta);
    }
}
//# sourceMappingURL=memory.js.map