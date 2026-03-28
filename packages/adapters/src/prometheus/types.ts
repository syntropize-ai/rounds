// Prometheus HTTP API response types

export type PrometheusResultType = 'matrix' | 'vector' | 'scalar' | 'string';

export interface PrometheusMetric {
  [label: string]: string;
}

/** A single sample: [unixTimestamp, value] */
export type PrometheusSample = [number, string];

/** Instant vector result item */
export interface PrometheusVectorItem {
  metric: PrometheusMetric;
  value: PrometheusSample;
}

/** Range vector result item */
export interface PrometheusMatrixItem {
  metric: PrometheusMetric;
  values: PrometheusSample[];
}

export interface PrometheusQueryResponse {
  status: 'success' | 'error';
  data: {
    resultType: 'vector';
    result: PrometheusVectorItem[];
  };
  errorType?: string;
  error?: string;
  warnings?: string[];
}

export interface PrometheusRangeResponse {
  status: 'success' | 'error';
  data: {
    resultType: 'matrix';
    result: PrometheusMatrixItem[];
  };
  errorType?: string;
  error?: string;
  warnings?: string[];
}

/** Parsed time series data point */
export interface TimeSeriesPoint {
  timestamp: number;
  value: number;
}

/** A single labeled time series */
export interface TimeSeries {
  labels: PrometheusMetric;
  points: TimeSeriesPoint[];
}

export interface PrometheusAdapterConfig {
  /** Prometheus base URL, e.g. http://prometheus:9090 */
  baseUrl: string;
  /** Optional basic auth credentials */
  auth?: { username: string; password: string };
  /** Request timeout in milliseconds (default: 30000) */
  timeoutMs?: number;
  /** Extra HTTP headers */
  headers?: Record<string, string>;
}