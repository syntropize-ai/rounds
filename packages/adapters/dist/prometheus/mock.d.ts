/**
 * Mock Prometheus HTTP API for use in tests.
 * Intercepts fetch calls and returns deterministic data.
 */
import type { PrometheusQueryResponse, PrometheusRangeResponse } from './types.js';

export type MockPromHandler = (path: string, params: URLSearchParams) => 
    PrometheusQueryResponse | PrometheusRangeResponse | null;

export declare function createMockFetch(handler?: MockPromHandler): typeof fetch;

/** Returns a mock fetch that always responds with a Prometheus error */
export declare function createErrorFetch(errorMsg: string): typeof fetch;