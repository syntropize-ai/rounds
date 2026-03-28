import type { DataAdapter } from '../adapter.js';
import type { Capabilities, SemanticQuery, StructuredResult, AdapterHealth } from '../types.js';
import type { ILogClient } from './client.js';
import type { LogAdapterConfig } from './types.js';

export interface LogAdapterOptions {
    config: LogAdapterConfig;
    /** Inject a custom client (useful for testing with MockLogClient) */
    client?: ILogClient;
    /** Adapter instance name, defaults to "log" */
    name?: string;
    /** Max log lines fetched per query (default: 1000) */
    defaultLimit?: number;
    /** Max sample lines per cluster (default: 3) */
    clusterSamples?: number;
}

export declare class LogAdapter implements DataAdapter {
    readonly name: string;
    readonly description = "Log adapter \u2014 supports Loki, Elasticsearch, and ClickHouse backends";
    private readonly client;
    private readonly defaultLimit;
    private readonly clusterSamples;
    constructor(options: LogAdapterOptions);
    meta(): Capabilities;
    query<T = unknown>(semanticQuery: SemanticQuery): Promise<StructuredResult<T>>;
    healthCheck(): Promise<AdapterHealth>;
}
//# sourceMappingURL=adapter.d.ts.map