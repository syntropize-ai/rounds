export type SemanticMetricName = 'request_rate' | 'error_rate' | 'p95_latency' | 'p99_latency' | 'saturation' | 'availability';
export type BackendType = 'prometheus' | 'datadog' | 'cloudwatch' | 'generic';
export interface LabelConstraint {
  label: string;
  /** required label that must be present */
  required: boolean;
  /** allowed values; if empty, any value is accepted */
  allowedValues?: string[];
}
export interface ServiceRule {
  /** glob pattern matching service names */
  servicePattern: string;
  /** override query template for matching services */
  queryTemplate: string;
}
export interface BackendMapping {
  backend: BackendType;
  /** PromQL / metric query template; use {{service}}, {{namespace}}, {{window}} placeholders */
  queryTemplate: string;
  labelConstraints: LabelConstraint[];
  serviceRules: ServiceRule[];
}
export interface SemanticMetric {
  id: string;
  name: SemanticMetricName | string;
  description: string;
  unit: string;
  /** Lower is better (latency) vs higher is better (availability) */
  direction: 'lower_is_better' | 'higher_is_better';
  defaultWindow: string;
  mappings: BackendMapping[];
  createdAt: string;
  updatedAt: string;
}
export interface ResolvedQuery {
  metricId: string;
  backend: BackendType;
  query: string;
  window: string;
}
export interface ResolveQueryParams {
  metricName: string;
  backend: BackendType;
  service: string;
  namespace?: string;
  window?: string;
  extraLabels?: Record<string, string>;
}
//# sourceMappingURL=types.d.ts.map
