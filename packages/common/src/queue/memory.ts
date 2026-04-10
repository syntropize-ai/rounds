// InMemoryWorkerQueue - synchronous, in-process queue for testing

import { randomUUID } from 'crypto';
import { createLogger } from '../logging/index.js';
import type { IWorkerQueue, JobOptions, JobRecord, JobHandler, QueueStats } from './interface.js';

const log = createLogger('memory-queue');

interface PendingJob<T = unknown> {
  record: JobRecord<T>;
  opts: Required<Pick<JobOptions, 'attempts' | 'delay'>>;
}

export class InMemoryWorkerQueue implements IWorkerQueue {
  private readonly queues = new Map<string, PendingJob[]>();
  private readonly handlers = new Map<string, JobHandler>();
  private readonly stats = new Map<string, QueueStats>();
  private closed = false;

  async enqueue<T>(queueName: string, data: T, opts: JobOptions = {}): Promise<string> {
    const id = randomUUID();
    const record: JobRecord<T> = {
      id,
      name: queueName,
      data,
      attempts: 0,
      createdAt: new Date().toISOString(),
    };

    const job: PendingJob<T> = {
      record,
      opts: { attempts: opts.attempts ?? 3, delay: opts.delay ?? 0 },
    };

    if (!this.queues.has(queueName)) this.queues.set(queueName, []);
    const queue = this.queues.get(queueName);
    if (queue) queue.push(job as PendingJob);

    this.incrementStat(queueName, 'waiting', 1);

    // Dispatch asynchronously after optional delay
    const handler = this.handlers.get(queueName);
    if (handler) {
      const dispatch = async () => {
        if (this.closed) return;
        const queue = this.queues.get(queueName);
        const idx = queue?.findIndex((j) => j.record.id === id) ?? -1;
        if (idx === -1) return;
        queue?.splice(idx, 1);
        this.incrementStat(queueName, 'waiting', -1);
        this.incrementStat(queueName, 'active', 1);
        try {
          await handler(record as JobRecord);
          this.incrementStat(queueName, 'active', -1);
          this.incrementStat(queueName, 'completed', 1);
        } catch (err) {
          log.warn({ err, queueName }, 'job handler failed');
          this.incrementStat(queueName, 'active', -1);
          this.incrementStat(queueName, 'failed', 1);
        }
      };

      if (opts.delay && opts.delay > 0) {
        setTimeout(() => void dispatch(), opts.delay);
      } else {
        void dispatch();
      }
    }

    return id;
  }

  process<T>(queueName: string, handler: JobHandler<T>): () => Promise<void> {
    this.handlers.set(queueName, handler as JobHandler);
    return async () => {
      this.handlers.delete(queueName);
    };
  }

  async getStats(queueName: string): Promise<QueueStats> {
    return this.stats.get(queueName) ?? { waiting: 0, active: 0, completed: 0, failed: 0 };
  }

  async close(): Promise<void> {
    this.closed = true;
    this.handlers.clear();
    this.queues.clear();
  }

  private initStat(queueName: string): QueueStats {
    let stat = this.stats.get(queueName);
    if (!stat) {
      stat = { waiting: 0, active: 0, completed: 0, failed: 0 };
      this.stats.set(queueName, stat);
    }

    return stat;
  }

  private incrementStat(queueName: string, key: keyof QueueStats, delta: number): void {
    const s = this.initStat(queueName);
    s[key] = Math.max(0, s[key] + delta);
  }
}
