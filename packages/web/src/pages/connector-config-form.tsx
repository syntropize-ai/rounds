import React from 'react';
import {
  getConnectorTemplate,
  type ConnectorType,
  type JsonSchema,
  type JsonSchemaProperty,
} from '@agentic-obs/common';

const inputCls =
  'w-full px-3 py-2 rounded-lg border border-[var(--color-outline-variant)] bg-[var(--color-surface-lowest)] text-[var(--color-on-surface)] text-sm placeholder-[var(--color-outline)] focus:outline-none focus:border-[var(--color-primary)] transition-colors';

// `apiServer` → `API server`, `clusterName` → `Cluster name`, `tlsVerify` → `TLS verify`.
// Split camelCase, then uppercase the first letter, then uppercase pure-acronym
// runs (URL, API, TLS, ID) that survived as their own tokens.
const ACRONYMS = new Set(['url', 'api', 'tls', 'id', 'uri']);
export function humanize(key: string): string {
  const tokens = key.replace(/([A-Z]+)/g, ' $1').trim().split(/\s+/);
  const out = tokens.map((tok, i) => {
    const lower = tok.toLowerCase();
    if (ACRONYMS.has(lower)) return lower.toUpperCase();
    if (i === 0) return tok.charAt(0).toUpperCase() + tok.slice(1).toLowerCase();
    return tok.toLowerCase();
  });
  return out.join(' ');
}

// Override: kubernetes form should require clusterName even though the schema
// does not enforce it — a cluster with no identifier is unusable in UX terms.
export function isRequired(
  type: ConnectorType,
  schema: JsonSchema,
  key: string,
): boolean {
  if (type === 'kubernetes' && key === 'clusterName') return true;
  return schema.required?.includes(key) ?? false;
}

// Type-specific placeholders for URI fields that lack a `description`.
const URI_PLACEHOLDERS: Partial<Record<ConnectorType, Partial<Record<string, string>>>> = {
  kubernetes: {
    apiServer: 'https://kubernetes.default.svc — leave blank to use in-cluster',
  },
  prometheus: { url: 'http://prometheus.monitoring.svc:9090 or Grafana/AMP proxy URL' },
  loki: { url: 'http://loki.monitoring.svc:3100' },
  'victoria-metrics': { url: 'http://victoria-metrics.monitoring.svc:8428' },
  elasticsearch: { url: 'http://elasticsearch.monitoring.svc:9200' },
  clickhouse: { url: 'http://clickhouse.monitoring.svc:8123' },
  tempo: { url: 'http://tempo.monitoring.svc:3200' },
  jaeger: { url: 'http://jaeger.monitoring.svc:16686' },
  otel: { url: 'http://otel-collector.monitoring.svc:4318' },
};

function placeholderFor(
  type: ConnectorType,
  key: string,
  prop: JsonSchemaProperty,
): string {
  if (prop.description) return prop.description;
  if (prop.format === 'uri') return URI_PLACEHOLDERS[type]?.[key] ?? '';
  return '';
}

// Persistent helper text shown under a field (placeholders disappear on focus).
const FIELD_HELP: Partial<Record<ConnectorType, Partial<Record<string, string>>>> = {
  prometheus: {
    url: 'API root or proxy URL that forwards /api/v1/query. Works with self-hosted Prometheus, AMP, and Grafana datasource proxies.',
  },
};

function helpFor(type: ConnectorType, key: string): string | null {
  return FIELD_HELP[type]?.[key] ?? null;
}

// Schema-driven default values. Used on type switch — keys that have a
// `default` in the new schema seed the form; others are dropped.
export function defaultsFor(type: ConnectorType): Record<string, unknown> {
  const schema = getConnectorTemplate(type).configSchema;
  const out: Record<string, unknown> = {};
  for (const [key, prop] of Object.entries(schema.properties ?? {})) {
    if (prop.default !== undefined) out[key] = prop.default;
  }
  return out;
}

// Carry over keys that are still valid in the new schema; drop the rest.
export function reconcileConfig(
  prevConfig: Record<string, unknown>,
  nextType: ConnectorType,
): Record<string, unknown> {
  const schema = getConnectorTemplate(nextType).configSchema;
  const nextKeys = new Set(Object.keys(schema.properties ?? {}));
  const out = defaultsFor(nextType);
  for (const [key, value] of Object.entries(prevConfig)) {
    if (nextKeys.has(key)) out[key] = value;
  }
  return out;
}

// All schema-required fields (plus UX-required overrides) have non-empty values.
export function configIsValid(
  type: ConnectorType,
  config: Record<string, unknown>,
): boolean {
  const schema = getConnectorTemplate(type).configSchema;
  const required = new Set(schema.required ?? []);
  if (type === 'kubernetes') required.add('clusterName');
  for (const key of required) {
    const v = config[key];
    if (typeof v !== 'string' || v.trim() === '') return false;
  }
  return true;
}

interface ConnectorConfigFieldsProps {
  type: ConnectorType;
  config: Record<string, unknown>;
  onChange: (next: Record<string, unknown>) => void;
}

export function ConnectorConfigFields({
  type,
  config,
  onChange,
}: ConnectorConfigFieldsProps) {
  const schema = getConnectorTemplate(type).configSchema;
  const properties = schema.properties ?? {};

  const setField = (key: string, value: unknown) => {
    onChange({ ...config, [key]: value });
  };

  return (
    <>
      {Object.entries(properties).map(([key, prop]) => {
        const label = humanize(key);
        const required = isRequired(type, schema, key);
        const placeholder = placeholderFor(type, key, prop);

        if (prop.type === 'boolean') {
          const initial = prop.default === true;
          const current = config[key];
          const checked = typeof current === 'boolean' ? current : initial;
          return (
            <label
              key={key}
              className="flex items-center gap-2 text-sm text-[var(--color-on-surface)]"
            >
              <input
                type="checkbox"
                checked={checked}
                onChange={(e) => setField(key, e.target.checked)}
                aria-label={label}
              />
              {label}
            </label>
          );
        }

        if (prop.type === 'number' || prop.type === 'integer') {
          const v = config[key];
          const value =
            typeof v === 'number' || typeof v === 'string' ? String(v) : '';
          return (
            <div key={key}>
              <label className="block text-sm font-medium text-[var(--color-on-surface)] mb-1.5">
                {label}
                {required ? ' *' : ''}
              </label>
              <input
                type="number"
                value={value}
                onChange={(e) => {
                  const raw = e.target.value;
                  setField(key, raw === '' ? '' : Number(raw));
                }}
                placeholder={placeholder}
                className={inputCls}
                required={required}
                aria-label={label}
              />
            </div>
          );
        }

        // string (with or without uri format) and fallback
        const inputType = prop.format === 'uri' ? 'url' : 'text';
        const v = config[key];
        const value = typeof v === 'string' ? v : '';
        const help = helpFor(type, key);
        return (
          <div key={key}>
            <label className="block text-sm font-medium text-[var(--color-on-surface)] mb-1.5">
              {label}
              {required ? ' *' : ''}
            </label>
            <input
              type={inputType}
              value={value}
              onChange={(e) => setField(key, e.target.value)}
              placeholder={placeholder}
              className={inputCls}
              required={required}
              aria-label={label}
            />
            {help && (
              <p className="text-xs text-[var(--color-on-surface-variant)] mt-1">{help}</p>
            )}
          </div>
        );
      })}
      {type === 'kubernetes' && (
        <p className="text-xs text-[var(--color-on-surface-variant)] mt-1.5">
          Auth credentials (kubeconfig or in-cluster service account) are
          configured separately via Policies after creation.
        </p>
      )}
    </>
  );
}
