// RedisEventBus - Redis Streams-backed implementation (ioredis)
//
// Publish = XADD <topic> * type <type> payload <json>
// Subscribe = XREADGROUP GROUP <group> <consumer> BLOCK 0 STREAMS <topic> >
//
// Each topic maps to one Redis stream.
// All subscribers within the same process share a single consumer group per topic.

import { Redis } from 'ioredis';
import { randomUUID } from 'crypto';
import { createLogger } from '../logging/index.js';

const log = createLogger('redis-event-bus');
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

type RawMessage = [id: string, fields: string[]];

export class RedisEventBus implements IEventBus {
  private readonly pub: Redis;
  private readonly sub: Redis;
  private readonly group: string;
  private readonly consumer: string;
  private readonly handlers = new Map<string, Set<EventHandler>>();
  private readonly streamTasks = new Map<string, { stop: () => void }>();
  private closed = false;

  constructor(opts: RedisEventBusOptions = {}) {
    if (opts.client) {
      this.pub = opts.client;
      this.sub = opts.client.duplicate();
    } else {
      const url = opts.url ?? 'redis://localhost:6379';
      this.pub = new Redis(url, { lazyConnect: true, maxRetriesPerRequest: 3 });
      this.sub = new Redis(url, { lazyConnect: true, maxRetriesPerRequest: null });
    }
    this.group = opts.group ?? 'agentic-obs';
    this.consumer = opts.consumer ?? randomUUID();
  }

  async publish<T>(topic: string, event: EventEnvelope<T>): Promise<void> {
    await this.pub.xadd(topic, '*', 'type', event.type, 'payload', JSON.stringify(event));
  }

  subscribe<T>(topic: string, handler: EventHandler<T>): () => void {
    if (!this.handlers.has(topic)) {
      this.handlers.set(topic, new Set());
      this.startReading(topic);
    }

    const set = this.handlers.get(topic)!;
    set.add(handler as EventHandler);

    return () => {
      set.delete(handler as EventHandler);
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

  async close(): Promise<void> {
    this.closed = true;
    for (const task of this.streamTasks.values()) {
      task.stop();
    }
    this.streamTasks.clear();
    this.handlers.clear();
    await Promise.allSettled([this.pub.quit(), this.sub.quit()]);
  }

  // Private helpers
  private startReading(topic: string): void {
    let active = true;
    const task = { stop: () => { active = false; } };
    this.streamTasks.set(topic, task);

    const loop = async () => {
      // Ensure consumer group exists (idempotent)
      try {
        await this.sub.xgroup('CREATE', topic, this.group, '$', 'MKSTREAM');
      } catch (err) {
        log.debug({ err }, 'consumer group may already exist (BUSYGROUP)');
      }

      while (active && !this.closed) {
        try {
          const results = await this.sub.xreadgroup(
            'GROUP', this.group, this.consumer,
            'COUNT', 100,
            'BLOCK', 1000,
            'STREAMS', topic, '>',
          ) as Array<[stream: string, messages: RawMessage[]]> | null;

          if (!results || !active) continue;

          for (const [, messages] of results) {
            for (const [msgId, fields] of messages) {
              const payloadIdx = fields.indexOf('payload');
              if (payloadIdx === -1) continue;
              const raw = fields[payloadIdx + 1] ?? '';
              try {
                const event = JSON.parse(raw) as EventEnvelope;
                const handlers = this.handlers.get(topic);
                if (handlers) {
                  for (const h of handlers) {
                    void h(event);
                  }
                }
                await this.sub.xack(topic, this.group, msgId);
              } catch (err) {
                log.warn({ err }, 'failed to parse or handle stream message');
              }
            }
          }
        } catch (err) {
          log.warn({ err }, 'redis stream read error, retrying');
          if (active && !this.closed) {
            await new Promise((r) => setTimeout(r, 500));
          }
        }
      }
    };

    void loop();
  }
}
