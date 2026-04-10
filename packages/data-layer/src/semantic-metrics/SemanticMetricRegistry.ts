import { randomUUID } from 'node:crypto';
import type {
  SemanticMetric,
  SemanticMetricName,
  BackendType,
  ResolvedQuery,
  ResolveQueryParams,
} from './types.js';

function randomId(): string {
  return randomUUID();
}

function now(): string {
  return new Date().toISOString();
}

/** Replace {{key}} placeholders in a template string */
function interpolate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key) => vars[key] ?? `{{${key}}}`);
}

export class SemanticMetricRegistry {
  private metrics: Map<string, SemanticMetric> = new Map();

  constructor() {
    this.loadDefaults();
  }

  // CRUD

  create(params: Omit<SemanticMetric, 'id' | 'createdAt' | 'updatedAt'>): SemanticMetric {
    const metric: SemanticMetric = {
      ...params,
      id: randomId(),
      createdAt: now(),
      updatedAt: now(),
    };
    this.metrics.set(metric.id, metric);
    return metric;
  }

  get(id: string): SemanticMetric | undefined {
    return this.metrics.get(id);
  }

  getByName(name: string): SemanticMetric | undefined {
    for (const m of this.metrics.values()) {
      if (m.name === name) return m;
    }
  }

  list(): SemanticMetric[] {
    return [...this.metrics.values()];
  }

  update(id: string, patch: Partial<Omit<SemanticMetric, 'id' | 'createdAt'>>): SemanticMetric {
    const existing = this.metrics.get(id);
    if (!existing) throw new Error(`Metric not found: ${id}`);
    const updated: SemanticMetric = { ...existing, ...patch, id, updatedAt: now() };
    this.metrics.set(id, updated);
    return updated;
  }

  delete(id: string): boolean {
    return this.metrics.delete(id);
  }

  // Query resolution

  resolveQuery(params: ResolveQueryParams): ResolvedQuery {
    const metric = this.getByName(params.metricName);
    if (!metric) throw new Error(`Unknown metric: ${params.metricName}`);

    const mapping = metric.mappings.find((m) => m.backend === params.backend);
    if (!mapping) {
      throw new Error(
        `No mapping for backend "${params.backend}" on metric "${params.metricName}"`,
      );
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
    const vars: Record<string, string> = {
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

  private matchesPattern(name: string, pattern: string): boolean {
    const regex = new RegExp(`^${pattern.replace(/\*/g, '.*')}$`);
    return regex.test(name);
  }

  // Default metrics

  private loadDefaults(): void {
    const defaults: Array<Omit<SemanticMetric, 'id' | 'createdAt' | 'updatedAt'>> = [
      {
        name: 'request_rate',
        description: 'Requests per second to a service',
        unit: 'req/s',
        direction: 'higher_is_better',
        defaultWindow: '5m',
        mappings: [
          {
            backend: 'prometheus',
            queryTemplate:
              'sum(rate(http_requests_total{service="{{service}}",namespace="{{namespace}}"}[{{window}}]))',
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
            queryTemplate:
              'sum(rate(http_requests_total{service="{{service}}",namespace="{{namespace}}",status=~"5.."}[{{window}}])) / sum(rate(http_requests_total{service="{{service}}",namespace="{{namespace}}"}[{{window}}]))',
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
            queryTemplate:
              'histogram_quantile(0.50, sum(rate(http_request_duration_seconds_bucket{service="{{service}}",namespace="{{namespace}}"}[{{window}}])) by (le)) * 1000',
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
            queryTemplate:
              'histogram_quantile(0.95, sum(rate(http_request_duration_seconds_bucket{service="{{service}}",namespace="{{namespace}}"}[{{window}}])) by (le)) * 1000',
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
            queryTemplate:
              'histogram_quantile(0.99, sum(rate(http_request_duration_seconds_bucket{service="{{service}}",namespace="{{namespace}}"}[{{window}}])) by (le)) * 1000',
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
            queryTemplate:
              'avg(rate(container_cpu_usage_seconds_total{namespace="{{namespace}}",pod=~"{{service}}.*"}[{{window}}])) / avg(kube_pod_container_resource_limits{namespace="{{namespace}}",pod=~"{{service}}.*",resource="cpu"})',
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
            queryTemplate:
              '1 - (sum(rate(http_requests_total{service="{{service}}",namespace="{{namespace}}",status=~"5.."}[{{window}}])) / sum(rate(http_requests_total{service="{{service}}",namespace="{{namespace}}"}[{{window}}])))',
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
