// DataAdapter interface - the contract every data source adapter must fulfill.
//
// AdapterError, AdapterErrorKind, and the HTTP classifier live in ./errors.ts
// (the canonical taxonomy shared with provider boundaries). This file
// re-exports them so legacy callsites that import from './adapter.js' keep
// working.

import type {
  Capabilities,
  SemanticQuery,
  StructuredResult,
  StreamSubscription,
  EventStream,
  AdapterHealth,
} from './types.js';

export {
  AdapterError,
  classifyHttpError as classifyAdapterHttpError,
  isAdapterError,
} from './errors.js';
export type { AdapterErrorKind, AdapterErrorCause } from './errors.js';

export interface DataAdapter {
  /** Unique identifier for this adapter instance (e.g. "prometheus-prod") */
  readonly name: string;
  /** Human-readable description */
  readonly description?: string;

  /** Declare what this adapter can provide */
  meta(): Capabilities;

  /**
   * Execute a semantic query and return a structured result.
   * Adapters must translate the SemanticQuery into their native query language.
   */
  query<T = unknown>(semanticQuery: SemanticQuery): Promise<StructuredResult<T>>;

  /**
   * Open a live stream for the given subscription.
   * Optional - adapters that do not support streaming may omit this.
   */
  stream?<T = unknown>(subscription: StreamSubscription): EventStream<T>;

  /** Check whether the underlying data source is reachable and healthy. */
  healthCheck(): Promise<AdapterHealth>;
}
