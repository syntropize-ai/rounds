// RedisEventBus - Redis Streams-backed implementation (ioredis)
//
// Publish = XADD <topic> * type <type> payload <json>
// Subscribe = XREADGROUP GROUP <group> <consumer> BLOCK 0 STREAMS <topic> >
//
// Each topic maps to one Redis stream.
// All subscribers within the same process share a single consumer group per topic.
import { Redis } from 'ioredis';
import { randomUUID } from 'crypto';
export class RedisEventBus {
    pub;
    sub;
    group;
    consumer;
    handlers = new Map();
    streamTasks = new Map();
    closed = false;
    constructor(opts = {}) {
        if (opts.client) {
            this.pub = opts.client;
            this.sub = opts.client.duplicate();
        }
        else {
            const url = opts.url ?? 'redis://localhost:6379';
            this.pub = new Redis(url, { lazyConnect: true, maxRetriesPerRequest: 3 });
            this.sub = new Redis(url, { lazyConnect: true, maxRetriesPerRequest: null });
        }
        this.group = opts.group ?? 'agentic-obs';
        this.consumer = opts.consumer ?? randomUUID();
    }
    async publish(topic, event) {
        await this.pub.xadd(topic, '*', 'type', event.type, 'payload', JSON.stringify(event));
    }
    subscribe(topic, handler) {
        if (!this.handlers.has(topic)) {
            this.handlers.set(topic, new Set());
            this.startReading(topic);
        }
        const set = this.handlers.get(topic);
        set.add(handler);
        return () => {
            set.delete(handler);
            if (set.size === 0) {
                this.handlers.delete(topic);
                const task = this.streamTasks.get(topic);
                if (task) {
                    task.stop();
                    this.streamTasks.delete(topic);
                }
            }
        };
    }
    async close() {
        this.closed = true;
        for (const task of this.streamTasks.values()) {
            task.stop();
        }
        this.streamTasks.clear();
        this.handlers.clear();
        await Promise.allSettled([this.pub.quit(), this.sub.quit()]);
    }
    // Private helpers
    startReading(topic) {
        let active = true;
        const task = { stop: () => { active = false; } };
        this.streamTasks.set(topic, task);
        const loop = async () => {
            // Ensure consumer group exists (idempotent)
            try {
                await this.sub.xgroup('CREATE', topic, this.group, '$', 'MKSTREAM');
            }
            catch {
                // Group already exists - ignore BUSYGROUP error
            }
            while (active && !this.closed) {
                try {
                    const results = await this.sub.xreadgroup('GROUP', this.group, this.consumer, 'COUNT', 100, 'BLOCK', 1000, 'STREAMS', topic, '>');
                    if (!results || !active)
                        continue;
                    for (const [, messages] of results) {
                        for (const [msgId, fields] of messages) {
                            const payloadIdx = fields.indexOf('payload');
                            if (payloadIdx === -1)
                                continue;
                            const raw = fields[payloadIdx + 1] ?? '';
                            try {
                                const event = JSON.parse(raw);
                                const handlers = this.handlers.get(topic);
                                if (handlers) {
                                    for (const h of handlers) {
                                        void h(event);
                                    }
                                }
                                await this.sub.xack(topic, this.group, msgId);
                            }
                            catch {
                                // Skip malformed messages
                            }
                        }
                    }
                }
                catch {
                    if (active && !this.closed) {
                        await new Promise((r) => setTimeout(r, 500));
                    }
                }
            }
        };
        void loop();
    }
}
//# sourceMappingURL=redis.js.map