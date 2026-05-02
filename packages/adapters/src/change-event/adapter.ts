// ChangeEventAdapter - implements DataAdapter for deployment/change events

import type { Change } from '@agentic-obs/common';
import type { DataAdapter } from '../adapter.js';
import type { ChangeRecord, ChangesListInput, IChangesAdapter } from '../interfaces.js';
import type {
  Capabilities,
  SemanticQuery,
  StructuredResult,
  StreamSubscription,
  StreamEvent,
  AdapterHealth,
} from '../types.js';
import type { WebhookPayload } from './types.js';
import { ChangeEventStore } from './store.js';
import { normalizeWebhook } from './normalizer.js';

export interface ChangeEventAdapterConfig {
  name?: string;
  /** Max events to keep in memory (oldest are dropped when limit is reached) */
  maxEvents?: number;
}

export class ChangeEventAdapter implements DataAdapter, IChangesAdapter {
  readonly name: string;
  readonly description = 'In-memory change event adapter (deploy, config, scale, feature flags)';

  private readonly store: ChangeEventStore;
  private readonly maxEvents: number;

  constructor(config: ChangeEventAdapterConfig = {}) {
    this.name = config.name ?? 'change-event';
    this.maxEvents = config.maxEvents ?? 10_000;
    this.store = new ChangeEventStore();
  }

  // -- DataAdapter --

  meta(): Capabilities {
    return {
      supportedMetrics: ['change_count', 'deploy_frequency', 'change_failure_rate'],
      timeGranularity: '1m',
      dimensions: [
        { name: 'serviceId', description: 'Service or repository identifier' },
        { name: 'type', description: 'Change type: deploy | config | scale | feature_flag' },
        { name: 'author', description: 'Change author' },
        { name: 'environment', description: 'Deployment environment' },
      ],
      supportedSignalTypes: ['changes', 'events'],
      supportsStreaming: true,
      supportsHistoricalQuery: true,
    };
  }

  async query<T = unknown>(semanticQuery: SemanticQuery): Promise<StructuredResult<T>> {
    const start = Date.now();
    const { entity, timeRange, filters, limit } = semanticQuery;

    const changes = this.store.query({
      serviceId: entity !== '*' ? entity : undefined,
      type: filters?.['type'] as Change['type'] | undefined,
      startTime: timeRange.start,
      endTime: timeRange.end,
      limit,
    });

    const queryUsed =
      `service=${entity} timeRange=[${timeRange.start.toISOString()},${timeRange.end.toISOString()}]` +
      (filters ? ` filters=${JSON.stringify(filters)}` : '');

    return {
      data: changes as T,
      metadata: {
        adapterName: this.name,
        signalType: 'changes',
        executedAt: new Date().toISOString(),
        coveredRange: timeRange,
        partial: false,
      },
      queryUsed,
      cost: { durationMs: Date.now() - start, pointsScanned: this.store.size },
    };
  }

  async *stream<T = unknown>(subscription: StreamSubscription): AsyncIterable<StreamEvent<T>> {
    // Yield existing matching events as a snapshot, then stop.
    // A production implementation would use an event emitter for live events.
    const changes = this.store.query({
      serviceId: subscription.entity,
      startTime: new Date(0),
      endTime: new Date(),
    });

    for (const change of changes) {
      const event: StreamEvent<T> = {
        timestamp: change.timestamp,
        signalType: 'changes',
        source: this.name,
        payload: change as T,
      };
      yield event;
    }
  }

  async healthCheck(): Promise<AdapterHealth> {
    return {
      status: 'healthy',
      latencyMs: 0,
      message: `${this.store.size} events in store`,
      checkedAt: new Date().toISOString(),
    };
  }

  async listRecent(input: ChangesListInput): Promise<ChangeRecord[]> {
    const endTime = new Date();
    const startTime = new Date(endTime.getTime() - input.windowMinutes * 60_000);
    return this.store.query({
      serviceId: input.service,
      startTime,
      endTime,
      limit: 100,
    }).map(toChangeRecord);
  }

  // -- Webhook ingestion --

  /**
   * Ingest a webhook payload, normalize it, and store the resulting Change.
   * Returns the normalized Change, or null if the payload was intentionally skipped.
   */
  ingestWebhook(event: WebhookPayload): Change | null {
    const change = normalizeWebhook(event);
    if (!change) return null;

    this.store.add(change);
    this.enforceMaxEvents();
    return change;
  }

  /**
   * Directly ingest a pre-normalized Change object (e.g. from an API poll).
   */
  ingestChange(change: Change): void {
    this.store.add(change);
    this.enforceMaxEvents();
  }

  // -- Utility --

  private enforceMaxEvents(): void {
    if (this.store.size <= this.maxEvents) return;
    // Query all events sorted by timestamp descending, keep only the most recent maxEvents
    const all = this.store.query({
      startTime: new Date(0),
      endTime: new Date(),
    });
    // all is sorted descending (most recent first) — keep the first maxEvents
    const toKeep = new Set(all.slice(0, this.maxEvents));
    this.store.clear();
    // Re-add in chronological order (reverse of descending)
    const kept = [...toKeep].reverse();
    for (const event of kept) {
      this.store.add(event);
    }
  }

  /** Expose the underlying store for integration use (e.g. registering webhook routes). */
  get changeStore(): ChangeEventStore {
    return this.store;
  }
}

const CHANGE_KIND: Record<Change['type'], ChangeRecord['kind']> = {
  deploy: 'deploy',
  config: 'config',
  scale: 'config',
  feature_flag: 'feature-flag',
};

function toChangeRecord(change: Change): ChangeRecord {
  return {
    id: change.id,
    service: change.serviceId,
    kind: CHANGE_KIND[change.type] ?? 'other',
    summary: change.description,
    at: change.timestamp,
    metadata: {
      author: change.author,
      ...(change.version ? { version: change.version } : {}),
      ...(change.diff ? { diff: change.diff } : {}),
    },
  };
}
