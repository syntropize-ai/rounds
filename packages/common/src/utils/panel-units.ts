import { extractMetricSelectors } from '../lint/promql-extract.js';

export interface PanelUnitQuery {
  expr?: string;
}

export interface PanelMetricMetadata {
  type?: string;
  help?: string;
  unit?: string;
}

export interface PanelUnitInput {
  title?: string;
  unit?: string;
  query?: string;
  queries?: PanelUnitQuery[];
  metadataByMetric?: Record<string, PanelMetricMetadata | undefined>;
}

export const CANONICAL_PANEL_UNITS = [
  'none',
  'short',
  'percent',
  'percentunit',
  'bytes',
  'decbytes',
  'bytes_si',
  'decbytes_si',
  'bps',
  'Bps',
  'reqps',
  'ops',
  'opsps',
  's',
  'ms',
  'dateTime',
] as const;

const CANONICAL_PANEL_UNIT_SET = new Set<string>(CANONICAL_PANEL_UNITS);

const UNIT_ALIASES: Record<string, string> = {
  '%': 'percent',
  pct: 'percent',
  percentage: 'percent',
  '0-100%': 'percent',
  '0-1%': 'percentunit',
  ratio: 'percentunit',
  rps: 'reqps',
  qps: 'reqps',
  'req/s': 'reqps',
  'request/s': 'reqps',
  'requests/s': 'reqps',
  '1/s': 'opsps',
  'ops/s': 'opsps',
  'op/s': 'opsps',
  'errors/s': 'opsps',
  'error/s': 'opsps',
  'err/s': 'opsps',
  'bytes/s': 'Bps',
  'b/s': 'Bps',
  'byte/s': 'Bps',
  bps_bytes: 'Bps',
  seconds: 's',
  second: 's',
  milliseconds: 'ms',
  millisecond: 'ms',
};

const REQUEST_RATE_UNITS = new Set(['reqps', 'rps', 'qps', 'req/s', 'request/s', 'requests/s', '1/req']);

export function normalizePanelUnit(unit: string | undefined): string | undefined {
  const trimmed = unit?.trim();
  if (!trimmed) return undefined;
  const lower = trimmed.toLowerCase();
  const normalized = UNIT_ALIASES[lower] ?? trimmed;
  return CANONICAL_PANEL_UNIT_SET.has(normalized) ? normalized : normalized;
}

export function isCanonicalPanelUnit(unit: string | undefined): boolean {
  const normalized = normalizePanelUnit(unit);
  return !!normalized && CANONICAL_PANEL_UNIT_SET.has(normalized);
}

function panelText(panel: PanelUnitInput): string {
  const exprs = [
    panel.query,
    ...(panel.queries ?? []).map((q) => q.expr),
  ].filter((v): v is string => typeof v === 'string');
  return `${panel.title ?? ''}\n${exprs.join('\n')}`.toLowerCase();
}

export function extractPanelMetricNames(panel: PanelUnitInput): string[] {
  const names = new Set<string>();
  const exprs = [
    panel.query,
    ...(panel.queries ?? []).map((q) => q.expr),
  ].filter((v): v is string => typeof v === 'string');
  for (const expr of exprs) {
    for (const sel of extractMetricSelectors(expr)) {
      if (sel.name) names.add(sel.name);
    }
  }
  return [...names];
}

function looksLikePercentPanel(text: string): boolean {
  return (
    /\b(utili[sz]ation|usage|saturation|percent|percentage|ratio)\b/.test(text) &&
    (
      /\b(percent|percentage|ratio)\b/.test(text) ||
      /\blimit\b|\bquota\b/.test(text) ||
      /\*\s*100\b/.test(text) ||
      /\/\s*.+\*\s*100\b/.test(text)
    )
  );
}

function looksLikeRequestRatePanel(text: string): boolean {
  return /\brate\s*\(/.test(text) && /(?:requests?|http|grpc|rpc).*_total\b/.test(text);
}

function looksLikeByteRatePanel(text: string): boolean {
  return /\brate\s*\(/.test(text) && /_bytes_total\b/.test(text);
}

function looksLikeBytesPanel(text: string): boolean {
  return /_bytes\b/.test(text) && !looksLikeByteRatePanel(text);
}

function looksLikeDurationPanel(text: string): boolean {
  return /(?:duration|latency|seconds|milliseconds|p9[059])/.test(text) && /_seconds(?:_bucket|_sum|_count)?\b/.test(text);
}

function firstMetadataUnit(panel: PanelUnitInput): string | undefined {
  const metadata = panel.metadataByMetric;
  if (!metadata) return undefined;
  for (const name of extractPanelMetricNames(panel)) {
    const unit = normalizePanelUnit(metadata[name]?.unit);
    if (unit) return unit;
  }
  return undefined;
}

function firstMetadataType(panel: PanelUnitInput): string | undefined {
  const metadata = panel.metadataByMetric;
  if (!metadata) return undefined;
  for (const name of extractPanelMetricNames(panel)) {
    const type = metadata[name]?.type?.trim();
    if (type) return type.toLowerCase();
  }
  return undefined;
}

/**
 * Resolve the display unit for a panel from its declared unit plus the metric
 * semantics visible in the title/query. This is intentionally conservative:
 * a declared unit wins unless it is missing or obviously contradicts the
 * panel's metric family, e.g. CPU utilization marked as request rate.
 */
export function resolvePanelUnit(panel: PanelUnitInput): string | undefined {
  const declared = normalizePanelUnit(panel.unit);
  const text = panelText(panel);
  const metadataUnit = firstMetadataUnit(panel);
  const metadataType = firstMetadataType(panel);

  if (metadataUnit === 'percent' || metadataUnit === 'percentunit') {
    return metadataUnit;
  }

  if (metadataUnit === 'bytes' && looksLikeByteRatePanel(text)) {
    return 'Bps';
  }

  if ((metadataUnit === 's' || metadataUnit === 'seconds') && /\brate\s*\(|\birate\s*\(/.test(text)) {
    return declared ?? 'short';
  }

  if (looksLikePercentPanel(text)) {
    if (!declared || REQUEST_RATE_UNITS.has(declared.toLowerCase())) return 'percent';
  }

  if (!declared) {
    if (metadataUnit) return metadataUnit;
    if (metadataType === 'counter' && looksLikeRequestRatePanel(text)) return 'reqps';
    if (looksLikeByteRatePanel(text)) return 'Bps';
    if (looksLikeRequestRatePanel(text)) return 'reqps';
    if (looksLikeBytesPanel(text)) return 'bytes';
    if (looksLikeDurationPanel(text)) return 's';
  }

  return declared;
}
