import type { DataAdapter } from '../adapter.js';
import type { SemanticQuery, StructuredResult, Capabilities, AdapterHealth, StreamSubscription, EventStream } from '../types.js';
import type { PrometheusAdapterConfig } from './types.js';

type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;

export declare class PrometheusAdapter implements DataAdapter {
    readonly name: string;
    readonly description = "Prometheus metrics adapter";
    private readonly config;
    private readonly fetchFn;
    constructor(config: PrometheusAdapterConfig, fetchFn?: FetchFn);
    meta(): Capabilities;
    query<T = unknown>(semanticQuery: SemanticQuery): Promise<StructuredResult<T>>;
    stream<T = unknown>(_semanticQuery: SemanticQuery): StreamSubscription<EventStream<T>>;
    healthCheck(): Promise<AdapterHealth>;
    private instantQuery;
    private rangeQuery;
    private doFetch;
    private vectorToTimeSeries;
    private matrixToTimeSeries;
    /**
     * Choose a step interval for range queries to cap result size around 300 points
     */
    private inferStep;
}

export {};

//# sourceMappingURL=adapter.d.ts.map