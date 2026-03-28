import type { DataAdapter } from '../adapter.js';
import type { 
    SemanticQuery, 
    StructuredResult, 
    Capabilities, 
    AdapterHealth, 
    StreamSubscription, 
    EventStream 
} from '../types.js';
import type { IPrometheusClient } from './client.js';

export interface PrometheusAdapterOptions {
    config: PrometheusAdapterConfig;
    /** Inject a custom client (useful for testing with MockPrometheusClient) */
    client?: IPrometheusClient;
    /** Adapter instance name, defaults to "prometheus" */
    name?: string;
}

export declare class PrometheusAdapter implements DataAdapter {
    readonly name: string;
    readonly description: string; // "Prometheus metrics adapter supports range and instant queries"
    private readonly client;

    constructor(options: PrometheusAdapterOptions);

    meta(): Capabilities;

    query<T = unknown>(semanticQuery: SemanticQuery): Promise<StructuredResult<T>>;

    healthCheck(): Promise<AdapterHealth>;

    stream?<T = unknown>(subscription: StreamSubscription): EventStream<T>;

    private isInstantQuery;
    private resolveStep;
}

//# sourceMappingURL=PrometheusAdapter.d.ts.map