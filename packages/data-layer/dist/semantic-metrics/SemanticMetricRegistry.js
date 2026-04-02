function randomId() {
  return Math.random().toString(36).slice(2, 10);
}
function now() {
  return new Date().toISOString();
}
/** Replace {{key}} placeholders in a template string */
function interpolate(template, vars) {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key) => vars[key] ?? `{{${key}}}`);
}
export class SemanticMetricRegistry {
  metrics = new Map();
  constructor() {
    this.loadDefaults();
  }
  // CRUD
  create(params) {
    const metric = {
      ...params,
      id: randomId(),
      createdAt: now(),
      updatedAt: now(),
    };
    this.metrics.set(metric.id, metric);
    return metric;
  }
  get(id) {
    return this.metrics.get(id);
  }
  getByName(name) {
    for (const m of this.metrics.values()) {
      if (m.name === name)
        return m;
    }
  }
  list() {
    return [...this.metrics.values()];
  }
  update(id, patch) {
    const existing = this.metrics.get(id);
    if (!existing) {
      throw new Error(`Metric not found: ${id}`);
    }
    const updated = { ...existing, ...patch, id, updatedAt: now() };
    this.metrics.set(id, updated);
    return updated;
  }
  delete(id) {
    return this.metrics.delete(id);
  }
  // Query resolution
  resolveQuery(params) {
    const metric = this.getByName(params.metricName);
    if (!metric) {
      throw new Error(`Unknown metric: ${params.metricName}`);
    }
    const mapping = metric.mappings.find((m) => m.backend === params.backend);
    if (!mapping) {
      throw new Error(`No mapping for backend "${params.backend}" on metric "${params.metricName}"`);
    }
    // Check for service-specific override
    let template = mapping.queryTemplate;
    for (const rule of mapping.serviceRules) {
      if (this.matchesPattern(params.service, rule.servicePattern)) {
        template = rule.queryTemplate;
        break;
      }
    }
    const window = params.window ?? metric.defaultWindow;
    const vars = {
      service: params.service,
      namespace: params.namespace ?? 'default',
      window,
      ...params.extraLabels,
    };
    return {
      metricId: metric.id,
      backend: params.backend,
      query: interpolate(template, vars),
      window,
    };
  }
  matchesPattern(name, pattern) {
    const regex = new RegExp(`^${pattern.replace(/\*/g, '.*')}$`);
    return regex.test(name);
  }
  // Defaults
  loadDefaults() {
    const defaults = [
      {
        name: 'request_rate',
        description: 'Requests per second to a service',
        unit: 'req/s',
        direction: 'higher_is_better',
        defaultWindow: '5m',
        mappings: [
          {
            backend: 'prometheus',
            queryTemplate: 'sum(rate(http_requests_total{service="{{service}}", namespace="{{namespace}}"}[{{window}}]))',
            labelConstraints: [
              { label: 'service', required: true },
              { label: 'namespace', required: false },
            ],
            serviceRules: [],
          },
        ],
      },
      {
        name: 'error_rate',
        description: 'HTTP 5xx error rate as a fraction of total requests',
        unit: 'ratio',
        direction: 'lower_is_better',
        defaultWindow: '5m',
        mappings: [
          {
            backend: 'prometheus',
            queryTemplate: 'sum(rate(http_requests_total{service="{{service}}", namespace="{{namespace}}",status=~"5.."}[{{window}}])) / sum(rate(http_requests_total{service="{{service}}", namespace="{{namespace}}"}[{{window}}]))',
            labelConstraints: [
              { label: 'service', required: true },
              { label: 'status', required: false },
            ],
            serviceRules: [],
          },
        ],
      },
      {
        name: 'p50_latency',
        description: 'Median request latency',
        unit: 'ms',
        direction: 'lower_is_better',
        defaultWindow: '5m',
        mappings: [
          {
            backend: 'prometheus',
            queryTemplate: 'histogram_quantile(0.50, sum(rate(http_request_duration_seconds_bucket{service="{{service}}", namespace="{{namespace}}"}[{{window}}])) by (le)) * 1000',
            labelConstraints: [{ label: 'service', required: true }],
            serviceRules: [],
          },
        ],
      },
      {
        name: 'p95_latency',
        description: '95th percentile request latency',
        unit: 'ms',
        direction: 'lower_is_better',
        defaultWindow: '5m',
        mappings: [
          {
            backend: 'prometheus',
            queryTemplate: 'histogram_quantile(0.95, sum(rate(http_request_duration_seconds_bucket{service="{{service}}", namespace="{{namespace}}"}[{{window}}])) by (le)) * 1000',
            labelConstraints: [{ label: 'service', required: true }],
            serviceRules: [],
          },
        ],
      },
      {
        name: 'p99_latency',
        description: '99th percentile request latency',
        unit: 'ms',
        direction: 'lower_is_better',
        defaultWindow: '5m',
        mappings: [
          {
            backend: 'prometheus',
            queryTemplate: 'histogram_quantile(0.99, sum(rate(http_request_duration_seconds_bucket{service="{{service}}", namespace="{{namespace}}"}[{{window}}])) by (le)) * 1000',
            labelConstraints: [{ label: 'service', required: true }],
            serviceRules: [],
          },
        ],
      },
      {
        name: 'saturation',
        description: 'CPU utilization as a proxy for service saturation',
        unit: 'ratio',
        direction: 'lower_is_better',
        defaultWindow: '5m',
        mappings: [
          {
            backend: 'prometheus',
            queryTemplate: 'rate(container_cpu_usage_seconds_total{namespace="{{namespace}}", pod=~"{{service}}.*"}[{{window}}]) / by(kube_pod_container_resource_limits{namespace="{{namespace}}", pod=~"{{service}}.*"})',
            labelConstraints: [
              { label: 'namespace', required: true },
              { label: 'pod', required: false },
            ],
            serviceRules: [],
          },
        ],
      },
      {
        name: 'availability',
        description: 'Service availability (success ratio)',
        unit: 'ratio',
        direction: 'higher_is_better',
        defaultWindow: '5m',
        mappings: [
          {
            backend: 'prometheus',
            queryTemplate: '1 - (sum(rate(http_requests_total{service="{{service}}", namespace="{{namespace}}",status=~"5.."}[{{window}}])) / sum(rate(http_requests_total{service="{{service}}", namespace="{{namespace}}"}[{{window}}])))',
            labelConstraints: [{ label: 'service', required: true }],
            serviceRules: [],
          },
        ],
      },
    ];
    for (const def of defaults) {
      this.create(def);
    }
  }
}
//# sourceMappingURL=SemanticMetricRegistry.js.map
