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

export interface PanelDisplayUnit {
  unit?: string;
  /** Multiplicative transform applied to raw query values before formatting. */
  valueScale: number;
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

function hasPercentTransform(text: string): boolean {
  return /\*\s*100\b/.test(text) || /100\s*\*/.test(text);
}

function looksLikeCpuSecondsRate(text: string): boolean {
  return /\brate\s*\(/.test(text) && /\b(?:process|container|node|system)?_?cpu(?:_usage)?_seconds_total\b/.test(text);
}

function looksLikeCpuPercentPanel(text: string): boolean {
  return (
    /\bcpu\b/.test(text) &&
    /\b(utili[sz]ation|usage|percent|percentage)\b/.test(text) &&
    looksLikeCpuSecondsRate(text)
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
  return resolvePanelDisplayUnit(panel).unit;
}

/**
 * Resolve both display unit and raw-value scaling. Some metric families are
 * semantically percentages but PromQL returns a ratio/core value unless the
 * query explicitly multiplies by 100. Treating this as just a unit suffix is
 * how panels end up showing CPU "0.34%" instead of "34%".
 */
export function resolvePanelDisplayUnit(panel: PanelUnitInput): PanelDisplayUnit {
  const declared = normalizePanelUnit(panel.unit);
  const text = panelText(panel);
  const metadataUnit = firstMetadataUnit(panel);
  const metadataType = firstMetadataType(panel);

  if (metadataUnit === 'percent' || metadataUnit === 'percentunit') {
    return metadataUnit === 'percentunit'
      ? { unit: 'percent', valueScale: 100 }
      : { unit: metadataUnit, valueScale: 1 };
  }

  if (metadataUnit === 'bytes' && looksLikeByteRatePanel(text)) {
    return { unit: 'Bps', valueScale: 1 };
  }

  if ((metadataUnit === 's' || metadataUnit === 'seconds') && /\brate\s*\(|\birate\s*\(/.test(text)) {
    if (looksLikeCpuPercentPanel(text)) {
      return { unit: 'percent', valueScale: hasPercentTransform(text) ? 1 : 100 };
    }
    return { unit: declared ?? 'short', valueScale: 1 };
  }

  if (looksLikeCpuPercentPanel(text)) {
    return { unit: 'percent', valueScale: hasPercentTransform(text) ? 1 : 100 };
  }

  if (looksLikePercentPanel(text)) {
    if (!declared || REQUEST_RATE_UNITS.has(declared.toLowerCase())) {
      return { unit: 'percent', valueScale: 1 };
    }
  }

  if (!declared) {
    if (metadataUnit) return { unit: metadataUnit, valueScale: 1 };
    if (metadataType === 'counter' && looksLikeRequestRatePanel(text)) return { unit: 'reqps', valueScale: 1 };
    if (looksLikeByteRatePanel(text)) return { unit: 'Bps', valueScale: 1 };
    if (looksLikeRequestRatePanel(text)) return { unit: 'reqps', valueScale: 1 };
    if (looksLikeBytesPanel(text)) return { unit: 'bytes', valueScale: 1 };
    if (looksLikeDurationPanel(text)) return { unit: 's', valueScale: 1 };
  }

  if (declared === 'percentunit') {
    return { unit: 'percent', valueScale: 100 };
  }

  return { unit: declared, valueScale: 1 };
}
