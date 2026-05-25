import { extractMetricSelectors } from '../lint/promql-extract.js';

/**
 * Panel unit resolution. Deliberately a thin layer over the two
 * authoritative sources:
 *
 *   1. `panel.unit` — explicitly declared on the panel.
 *   2. `panel.metadataByMetric[<metric>].unit` — Prometheus metadata
 *      (HELP / UNIT exposed by the exporter, scraped by the backend).
 *
 * There is no title-string parsing, no query-shape regex, no
 * "looks-like-CPU-percent" heuristic. Inferring panel intent from a
 * stringified title was rule-based fallback dressed up as inference —
 * it broke quietly on vendor-prefixed metric names and contradicted
 * what the panel actually declared.
 *
 * The one definition-based transform we keep is `percentunit → percent`:
 * Prometheus documents `percentunit` as a value in [0, 1] formatted as
 * a percentage; that's not a guess, it's the unit's specification.
 * Everything else is reported as-declared (or undefined when neither
 * source has an opinion). If the agent or a user wants a metric
 * displayed in a particular unit, they declare it; if they need
 * scaling, they bake `* 100` (or whatever) into the PromQL.
 */

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
  /** Multiplicative transform applied to raw query values before formatting.
   *  Only set when the declared / metadata unit is `percentunit` (data in
   *  [0,1], rendered as percentage). Otherwise 1. */
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
  'bytes/s': 'Bps',
  'b/s': 'Bps',
  'byte/s': 'Bps',
  bps_bytes: 'Bps',
  seconds: 's',
  second: 's',
  milliseconds: 'ms',
  millisecond: 'ms',
};

export function normalizePanelUnit(unit: string | undefined): string | undefined {
  const trimmed = unit?.trim();
  if (!trimmed) return undefined;
  const lower = trimmed.toLowerCase();
  return UNIT_ALIASES[lower] ?? trimmed;
}

export function isCanonicalPanelUnit(unit: string | undefined): boolean {
  const normalized = normalizePanelUnit(unit);
  return !!normalized && CANONICAL_PANEL_UNIT_SET.has(normalized);
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

function firstMetadataUnit(panel: PanelUnitInput): string | undefined {
  const metadata = panel.metadataByMetric;
  if (!metadata) return undefined;
  for (const name of extractPanelMetricNames(panel)) {
    const unit = normalizePanelUnit(metadata[name]?.unit);
    if (unit) return unit;
  }
  return undefined;
}

/**
 * Resolve the display unit for a panel.
 *
 *   declared unit  →  honored (after normalization)
 *   metadata unit  →  used only when no declared unit
 *   neither        →  undefined; renderer falls back to its default formatter
 *
 * `percentunit` is rewritten to `percent` with `valueScale: 100`
 * because that's the Prometheus-documented meaning of the unit.
 */
export function resolvePanelDisplayUnit(panel: PanelUnitInput): PanelDisplayUnit {
  const declared = normalizePanelUnit(panel.unit);
  const metadataUnit = firstMetadataUnit(panel);
  const chosen = declared ?? metadataUnit;

  if (chosen === 'percentunit') {
    return { unit: 'percent', valueScale: 100 };
  }
  return { unit: chosen, valueScale: 1 };
}

/** Convenience wrapper for callers that only need the unit string. */
export function resolvePanelUnit(panel: PanelUnitInput): string | undefined {
  return resolvePanelDisplayUnit(panel).unit;
}
