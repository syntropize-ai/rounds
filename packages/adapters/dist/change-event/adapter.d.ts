import type { Change } from '@agentic-obs/common';
import type { DataAdapter } from '../adapter.js';
import type { Capabilities, SemanticQuery, StructuredResult, StreamSubscription, StreamEvent, AdapterHealth } from '../types.js';
import type { WebhookPayload } from './types.js';
import { ChangeEventStore } from './store.js';

export interface ChangeEventAdapterConfig {
    name?: string;
    /** Max events to keep in memory (oldest are dropped when limit is reached) */
    maxEvents?: number;
}

export export declare class ChangeEventAdapter implements DataAdapter {
    readonly name: string;
    readonly description = "In-memory change event adapter (deploy, config, scale, feature flags)";
    private readonly store;
    private readonly maxEvents;

    constructor(config?: ChangeEventAdapterConfig);
    meta(): Capabilities;
    query<T = unknown>(semanticQuery: SemanticQuery): Promise<StructuredResult<T>>;
    stream<T = unknown>(subscription: StreamSubscription): AsyncIterable<StreamEvent<T>>;
    healthCheck(): Promise<AdapterHealth>;

    /**
     * Ingest a webhook payload, normalize it, and store the resulting Change.
     * Returns the normalized Change, or null if the payload was intentionally skipped.
     */
    ingestWebhook(event: WebhookPayload): Change | null;

    /**
     * Directly ingest a pre-normalized Change object (e.g. from an API poll).
     */
    ingestChange(change: Change): void;

    private enforceMaxEvents;

    /** Expose the underlying store for integration use (e.g. registering webhook routes). */
    get changeStore(): ChangeEventStore;
}
//# sourceMappingURL=adapter.d.ts.map