export type ConnectorCategory = 'observability' | 'runtime' | 'code' | 'change';

export type ConnectorType =
  | 'prometheus'
  | 'victoria-metrics'
  | 'loki'
  | 'elasticsearch'
  | 'clickhouse'
  | 'tempo'
  | 'jaeger'
  | 'otel'
  | 'kubernetes'
  | 'github';

export type ConnectorCredentialKind =
  | 'none'
  | 'token'
  | 'oauth'
  | 'kubeconfig'
  | 'aws-keys';

export interface JsonSchema {
  type: string;
  required?: string[];
  properties?: Record<string, JsonSchemaProperty>;
  additionalProperties?: boolean;
}

export interface JsonSchemaProperty {
  type: string;
  format?: string;
  default?: unknown;
  enum?: string[];
  description?: string;
}

export type DetectStrategy =
  | {
      kind: 'k8s-service-probe';
      candidates: string[];
    }
  | {
      kind: 'manual';
    };

export type VerifyStrategy =
  | {
      kind: 'http-get';
      path: string;
    }
  | {
      kind: 'kubernetes-version';
    }
  | {
      kind: 'github-api';
    }
  | {
      kind: 'none';
    };

export interface ConnectorTemplate {
  type: ConnectorType;
  category: ConnectorCategory[];
  capabilities: string[];
  configSchema: JsonSchema;
  credential: ConnectorCredentialKind;
  detect?: DetectStrategy;
  verify: VerifyStrategy;
}

const httpUrlSchema: JsonSchema = {
  type: 'object',
  required: ['url'],
  properties: {
    url: { type: 'string', format: 'uri' },
    tlsVerify: { type: 'boolean', default: true },
  },
  additionalProperties: false,
};

export const PROMETHEUS_TEMPLATE: ConnectorTemplate = {
  type: 'prometheus',
  category: ['observability'],
  capabilities: ['metrics.discover', 'metrics.query', 'metrics.validate'],
  configSchema: httpUrlSchema,
  credential: 'token',
  detect: {
    kind: 'k8s-service-probe',
    candidates: [
      'http://prometheus.monitoring.svc:9090',
      'http://prometheus-server.monitoring.svc:80',
      'http://kube-prometheus-stack-prometheus.monitoring.svc:9090',
    ],
  },
  verify: { kind: 'http-get', path: '/api/v1/status/buildinfo' },
};

export const VICTORIA_METRICS_TEMPLATE: ConnectorTemplate = {
  type: 'victoria-metrics',
  category: ['observability'],
  capabilities: ['metrics.discover', 'metrics.query', 'metrics.validate'],
  configSchema: httpUrlSchema,
  credential: 'token',
  verify: { kind: 'http-get', path: '/api/v1/status/buildinfo' },
};

export const LOKI_TEMPLATE: ConnectorTemplate = {
  type: 'loki',
  category: ['observability'],
  capabilities: ['logs.query', 'logs.stream'],
  configSchema: httpUrlSchema,
  credential: 'token',
  verify: { kind: 'http-get', path: '/ready' },
};

export const ELASTICSEARCH_TEMPLATE: ConnectorTemplate = {
  type: 'elasticsearch',
  category: ['observability'],
  capabilities: ['logs.query'],
  configSchema: httpUrlSchema,
  credential: 'token',
  verify: { kind: 'http-get', path: '/' },
};

export const CLICKHOUSE_TEMPLATE: ConnectorTemplate = {
  type: 'clickhouse',
  category: ['observability'],
  capabilities: ['logs.query'],
  configSchema: {
    type: 'object',
    required: ['url'],
    properties: {
      url: { type: 'string', format: 'uri' },
      database: { type: 'string' },
      tlsVerify: { type: 'boolean', default: true },
    },
    additionalProperties: false,
  },
  credential: 'token',
  verify: { kind: 'http-get', path: '/ping' },
};

export const TEMPO_TEMPLATE: ConnectorTemplate = {
  type: 'tempo',
  category: ['observability'],
  capabilities: ['traces.query'],
  configSchema: httpUrlSchema,
  credential: 'token',
  verify: { kind: 'http-get', path: '/ready' },
};

export const JAEGER_TEMPLATE: ConnectorTemplate = {
  type: 'jaeger',
  category: ['observability'],
  capabilities: ['traces.query'],
  configSchema: httpUrlSchema,
  credential: 'token',
  verify: { kind: 'http-get', path: '/' },
};

export const OTEL_TEMPLATE: ConnectorTemplate = {
  type: 'otel',
  category: ['observability'],
  capabilities: ['traces.query'],
  configSchema: httpUrlSchema,
  credential: 'token',
  verify: { kind: 'http-get', path: '/' },
};

export const KUBERNETES_TEMPLATE: ConnectorTemplate = {
  type: 'kubernetes',
  category: ['runtime'],
  capabilities: [
    'runtime.get',
    'runtime.list',
    'runtime.logs',
    'runtime.events',
    'runtime.restart',
    'runtime.scale',
    'runtime.rollout',
    'runtime.delete',
  ],
  configSchema: {
    type: 'object',
    properties: {
      clusterName: { type: 'string' },
      apiServer: { type: 'string', format: 'uri' },
      context: { type: 'string' },
    },
    additionalProperties: true,
  },
  credential: 'kubeconfig',
  verify: { kind: 'kubernetes-version' },
};

export const GITHUB_TEMPLATE: ConnectorTemplate = {
  type: 'github',
  category: ['code', 'change'],
  capabilities: [
    'vcs.repo.read',
    'vcs.diff.read',
    'vcs.pr.read',
    'vcs.pr.comment',
    'vcs.pr.create',
    'change.event.read',
  ],
  configSchema: {
    type: 'object',
    properties: {
      owner: { type: 'string' },
      repo: { type: 'string' },
      installationId: { type: 'string' },
    },
    additionalProperties: false,
  },
  credential: 'oauth',
  verify: { kind: 'github-api' },
};

export const CONNECTOR_TEMPLATES: readonly ConnectorTemplate[] = [
  PROMETHEUS_TEMPLATE,
  VICTORIA_METRICS_TEMPLATE,
  LOKI_TEMPLATE,
  ELASTICSEARCH_TEMPLATE,
  CLICKHOUSE_TEMPLATE,
  TEMPO_TEMPLATE,
  JAEGER_TEMPLATE,
  OTEL_TEMPLATE,
  KUBERNETES_TEMPLATE,
  GITHUB_TEMPLATE,
];

export const CONNECTOR_TEMPLATE_BY_TYPE: Readonly<Record<ConnectorType, ConnectorTemplate>> =
  CONNECTOR_TEMPLATES.reduce(
    (acc, template) => ({ ...acc, [template.type]: template }),
    {} as Record<ConnectorType, ConnectorTemplate>,
  );

export function getConnectorTemplate(type: ConnectorType): ConnectorTemplate {
  return CONNECTOR_TEMPLATE_BY_TYPE[type];
}
