export interface MetricSample {
  labels: Record<string, string>;
  value: number;
  timestamp: number;
}

export interface RangeResult {
  metric: Record<string, string>;
  values: Array<[number, string]>;
}

export interface MetricMetadata {
  type: string;
  help: string;
  unit: string;
}

export interface IMetricsAdapter {
  listMetricNames(): Promise<string[]>;
  listLabels(metric: string): Promise<string[]>;
  listLabelValues(label: string): Promise<string[]>;
  findSeries(matchers: string[]): Promise<string[]>;
  fetchMetadata(metricNames?: string[]): Promise<Record<string, MetricMetadata>>;
  instantQuery(expr: string): Promise<MetricSample[]>;
  rangeQuery(expr: string, start: Date, end: Date, step: string): Promise<RangeResult[]>;
  testQuery(expr: string): Promise<{ ok: boolean; error?: string }>;
  isHealthy(): Promise<boolean>;
}
