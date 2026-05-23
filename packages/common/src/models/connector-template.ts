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
  /**
   * Suggested capability names for this connector type. Used by the Policies
   * dialog as autocomplete hints — NOT an authoritative whitelist. Admins
   * may define policies for any capability string the runtime understands
   * (e.g. `runtime.apply`, `runtime.exec`) by typing it directly.
   */
  capabilities: string[];
  configSchema: JsonSchema;
  credential: ConnectorCredentialKind;
  detect?: DetectStrategy;
  verify: VerifyStrategy;
}

/**
 * Curated list of kubernetes capability names the Policies dialog suggests
 * for autocomplete.
 *
 * @deprecated Phase A (ops-trust-model v4): the Policies dialog is hidden
 * and the policy gate is the always-allow shim. Constant retained as
 * public API for back-compat; will be removed when the trust model
 * migration completes.
 */
export const KNOWN_KUBERNETES_CAPABILITIES: readonly string[] = [
  'runtime.get',
  'runtime.list',
  'runtime.describe',
  'runtime.logs',
  'runtime.events',
  'runtime.top',
  'runtime.create',
  'runtime.apply',
  'runtime.patch',
  'runtime.delete',
  'runtime.scale',
  'runtime.restart',
  'runtime.rollout',
  'runtime.exec',
  'runtime.port_forward',
  'runtime.drain',
  'runtime.cordon',
  'runtime.uncordon',
  // Cluster-shell steps (remediation plan kind = `ops.cluster_shell`). Used
  // for operations that aren't kubectl-shaped — `istioctl install`,
  // `helm install`, `curl | sh` bootstraps. Executor runs the script in a
  // one-shot Job inside the user's cluster. Split by scope so cluster-wide
  // installs require the cluster-admin team to approve while
  // namespace-scoped scripts only need an interactive confirm from the
  // user who already has write rights in that namespace.
  'runtime.cluster_shell.cluster',
  'runtime.cluster_shell.namespace',
];

/**
 * Default policy seed for kubernetes connectors.
 *
 * @deprecated Phase A (ops-trust-model v4): the policy table that this
 * seed populated is no longer consulted by the ops command runner. The
 * runner always allows; kubectl RBAC is the real gate. Constant retained
 * to keep public API stable through the deprecation window.
 *
 * Importers re-export this from `@agentic-obs/common`.
 */
export const KUBERNETES_DEFAULT_POLICIES: ReadonlyArray<{
  capability: string;
  humanPolicy: 'allow' | 'confirm' | 'strong_confirm' | 'deny';
  agentPolicy: 'allow' | 'suggest' | 'formal_approval' | 'deny';
}> = [
  { capability: 'runtime.get', humanPolicy: 'allow', agentPolicy: 'allow' },
  { capability: 'runtime.list', humanPolicy: 'allow', agentPolicy: 'allow' },
  { capability: 'runtime.describe', humanPolicy: 'allow', agentPolicy: 'allow' },
  { capability: 'runtime.logs', humanPolicy: 'allow', agentPolicy: 'allow' },
  { capability: 'runtime.events', humanPolicy: 'allow', agentPolicy: 'allow' },
  { capability: 'runtime.top', humanPolicy: 'allow', agentPolicy: 'allow' },
  { capability: 'runtime.create', humanPolicy: 'confirm', agentPolicy: 'formal_approval' },
  { capability: 'runtime.apply', humanPolicy: 'confirm', agentPolicy: 'formal_approval' },
  { capability: 'runtime.patch', humanPolicy: 'confirm', agentPolicy: 'formal_approval' },
  { capability: 'runtime.delete', humanPolicy: 'strong_confirm', agentPolicy: 'formal_approval' },
  { capability: 'runtime.scale', humanPolicy: 'confirm', agentPolicy: 'formal_approval' },
  { capability: 'runtime.restart', humanPolicy: 'confirm', agentPolicy: 'formal_approval' },
  { capability: 'runtime.rollout', humanPolicy: 'confirm', agentPolicy: 'formal_approval' },
  { capability: 'runtime.exec', humanPolicy: 'strong_confirm', agentPolicy: 'deny' },
  { capability: 'runtime.port_forward', humanPolicy: 'confirm', agentPolicy: 'deny' },
  { capability: 'runtime.drain', humanPolicy: 'strong_confirm', agentPolicy: 'deny' },
  // Cluster-wide bootstrap (installing CRDs, control planes, cluster
  // operators): defaults to the strongest gate — humans `strong_confirm`,
  // agent `formal_approval` so the cluster-admin team must explicitly
  // approve. Operators who self-host can loosen per-team.
  { capability: 'runtime.cluster_shell.cluster', humanPolicy: 'strong_confirm', agentPolicy: 'formal_approval' },
  // Namespace-scoped scripts (deploying a chart into `apps/`, applying a
  // demo bundle): the user generally already has write rights, so the
  // default is an inline confirmation popup — no separate approver needed.
  // Agent still has to `suggest` (i.e. propose-and-confirm) rather than
  // execute silently.
  { capability: 'runtime.cluster_shell.namespace', humanPolicy: 'confirm', agentPolicy: 'suggest' },
];

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
