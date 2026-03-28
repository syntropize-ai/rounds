import type { Capabilities, SemanticQuery, StructuredResult, StreamSubscription, EventStream, AdapterHealth } from './types.js';

export interface DataAdapter {
  /** Unique identifier for this adapter instance (e.g. "prometheus-prod") */
  readonly name: string;
  /** Human-readable description */
  readonly description?: string;
  /** Declare what this adapter can provide */
  meta(): Capabilities;
  /** Execute a semantic query and return a structured result. */
  query<T = unknown>(semanticQuery: SemanticQuery): Promise<StructuredResult<T>>;
  /** Open a live stream for the given subscription. */
  stream<T = unknown>(subscription: StreamSubscription): EventStream<T>;
  /** Check whether the underlying data source is reachable and healthy. */
  healthCheck(): Promise<AdapterHealth>;
}