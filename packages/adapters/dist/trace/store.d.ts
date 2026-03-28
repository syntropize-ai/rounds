import { Span, Trace, WaterfallNode, TraceQuery } from './types.js';

export interface TraceStoreConfig {
  /** Max spans per individual trace before truncation */
  maxSpansPerTrace?: number;
  /** Max total traces to retain (oldest are evicted when limit is exceeded) */
  maxTraces?: number;
}

export declare class TraceStore {
  private readonly traces;
  private readonly insertOrder;
  private readonly maxSpansPerTrace;
  private readonly maxTraces;

  constructor(config?: TraceStoreConfig);

  /** Ingest a batch of spans, assembling (or updating) the corresponding Trace. */
  addSpans(spans: Span[]): void;

  /** Directly ingest a fully assembled Trace object. */
  addTrace(trace: Trace): void;

  getTrace(traceId: string): Trace | undefined;
  query(q: TraceQuery): Trace[];
  buildWaterfall(traceId: string): WaterfallNode | null;
  
  get size(): number;
  clear(): void;

  private upsertTrace;
  private deriveStatus;
  private matchesQuery;
  private buildNode;
  private evict;
}

//# sourceMappingURL=store.d.ts.map