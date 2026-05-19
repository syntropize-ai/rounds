/**
 * Dashboard lint engine — public types.
 *
 * The engine and rule registry are inspired by ESLint: each rule is a
 * self-contained module exporting a `LintRule`, the engine collects issues
 * across all rules, and the caller decides what to do with them (block save,
 * surface warnings, ...).
 *
 * The engine is intentionally async: rules may call into the metrics backend
 * (via `LintContext`) to verify queries return data, label selectors are
 * valid, etc.
 */

import type { Dashboard } from '../models/dashboard.js';

/** A `DashboardSpec` for lint purposes is just the persisted dashboard shape. */
export type DashboardSpec = Dashboard;

export type LintSeverity = 'error' | 'warn' | 'info';

export interface LintIssue {
  severity: LintSeverity;
  ruleName: string;
  /** Panel id when the issue is panel-scoped; omitted for dashboard-level issues. */
  panelId?: string;
  message: string;
  /** Optional fix hint shown to the agent or user. */
  fixHint?: string;
}

/**
 * Tools the rule may call. Every field is optional — some rules are pure
 * (string analysis only) and need nothing; others (e.g. `panel-returns-data`)
 * require `metricsQuery`. A rule that needs a missing tool reports a single
 * `info`-severity "rule skipped: <reason>" issue rather than throwing.
 */
export interface LintContext {
  metricsQuery?: (promql: string) => Promise<{ resultLen: number }>;
  metricsLabels?: (metricName: string) => Promise<{ labels: string[] }>;
  metricsLabelValues?: (metricName: string, label: string) => Promise<{ values: string[] }>;
  metricsCardinality?: (metricName: string) => Promise<{ seriesCount: number }>;
}

export interface LintRule {
  name: string;
  description: string;
  defaultSeverity: LintSeverity;
  check: (spec: DashboardSpec, ctx: LintContext) => Promise<LintIssue[]>;
}

export interface LintRunOptions {
  /** When set, only rules whose name is in this list run. */
  only?: string[];
  /** When set, rules in this list are excluded. Applied after `only`. */
  skip?: string[];
}
