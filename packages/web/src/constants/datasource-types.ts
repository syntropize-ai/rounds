/**
 * Single source of truth for datasource-type display metadata.
 *
 * Consumed by both the setup wizard (`StepConnectors`) and the
 * `Settings` page. Each entry carries every field any consumer needs:
 *
 *   value     — machine id (matches `DatasourceType` in @agentic-obs/common)
 *   label     — human-readable name
 *   category  — top-level grouping in the picker (`Logs` / `Traces` / `Metrics`)
 *   supported — true when a backend adapter is wired for this type. The
 *               setup wizard disables unsupported options in the picker
 *               (honest-about-what-works UX); the Settings page still
 *               shows the icon/color so existing saved entries render.
 *   icon      — short text glyph displayed in the Settings page list
 *   color     — accent color for the icon pill (hex)
 *
 * When a new adapter lands, flip `supported: true`. When a whole new
 * datasource type is added, add one entry here and one entry to the
 * `DatasourceType` union in `@agentic-obs/common/models/instance-config`.
 */

export interface DatasourceTypeInfo {
  value: string;
  label: string;
  category: 'Logs' | 'Traces' | 'Metrics';
  supported: boolean;
  icon: string;
  color: string;
}

export const DATASOURCE_TYPES: DatasourceTypeInfo[] = [
  { value: 'prometheus',       label: 'Prometheus',       category: 'Metrics', supported: true,  icon: 'P',  color: '#06E5F2' },
  { value: 'victoria-metrics', label: 'VictoriaMetrics',  category: 'Metrics', supported: true,  icon: 'VM', color: '#D2619C' },
  { value: 'loki',             label: 'Loki',             category: 'Logs',    supported: true,  icon: 'L',  color: '#7FA835' },
  { value: 'elasticsearch',    label: 'Elasticsearch',    category: 'Logs',    supported: false, icon: 'ES', color: '#00B0F3' },
  { value: 'clickhouse',       label: 'ClickHouse',       category: 'Logs',    supported: false, icon: 'CH', color: '#FFCC00' },
  { value: 'tempo',            label: 'Tempo',            category: 'Traces',  supported: false, icon: 'T',  color: '#FF701F' },
  { value: 'jaeger',           label: 'Jaeger',           category: 'Traces',  supported: false, icon: 'J',  color: '#400963' },
  { value: 'otel',             label: 'OTel Collector',   category: 'Traces',  supported: false, icon: 'OT', color: '#4FCFD7' },
];

/**
 * Look up the full metadata record for a datasource type. Falls back to
 * the first entry (prometheus) for unknown values — a safety net so the
 * UI renders something sensible if a saved row references a type that
 * has since been removed from this table.
 */
export function datasourceInfo(type: string): DatasourceTypeInfo {
  return DATASOURCE_TYPES.find((d) => d.value === type) ?? DATASOURCE_TYPES[0]!;
}
