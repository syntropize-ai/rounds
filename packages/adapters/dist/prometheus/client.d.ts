import type { PrometheusAdapterConfig, PrometheusQueryResponse, PrometheusRangeResponse } from './types.js';

export interface IPrometheusClient {
    instantQuery(promql: string, time?: Date): Promise<PrometheusQueryResponse>;
    rangeQuery(promql: string, start: Date, end: Date, step: string): Promise<PrometheusRangeResponse>;
    health(): Promise<boolean>;
}

export declare class PrometheusHttpClient implements IPrometheusClient {
    private readonly baseUrl;
    private readonly headers;
    private readonly timeoutMs;
    constructor(config: PrometheusAdapterConfig);
    instantQuery(promql: string, time?: Date): Promise<PrometheusQueryResponse>;
    rangeQuery(promql: string, start: Date, end: Date, step: string): Promise<PrometheusRangeResponse>;
    health(): Promise<boolean>;
    private fetch;
}

export interface MockSeries {
    metric: Record<string, string>;
    /** For range queries: array of [timestamp_seconds, value_string] */
    values?: [number, string][];
    /** For instant queries: [timestamp_seconds, value_string] */
    value?: [number, string];
}

export declare class MockPrometheusClient implements IPrometheusClient {
    private series;
    private healthy;
    setSeries(series: MockSeries[]): void;
    setHealthy(healthy: boolean): void;
    health(): Promise<boolean>;
    instantQuery(promql: string, time?: Date): Promise<PrometheusQueryResponse>;
    rangeQuery(promql: string, start: Date, end: Date, step: string): Promise<PrometheusRangeResponse>;
    private generateSyntheticValues;
}