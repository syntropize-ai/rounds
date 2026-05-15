import type { PublishStatus } from './version.js';
import type { ResourceSource, ResourceProvenance } from '../resources/writable-gate.js';

export type PanelVisualization =
  | 'time_series'
  | 'stat'
  | 'table'
  | 'gauge'
  | 'bar'
  | 'bar_gauge'
  | 'heatmap'
  | 'pie'
  | 'histogram'
  | 'status_timeline';

/** Bar-gauge fill style. `'gradient'` = single bar with color interpolation;
 *  `'lcd'` = segmented bar (Grafana-style LCD). */
export type BarGaugeMode = 'gradient' | 'lcd';

/** Time-stamped event marker shown as a vertical line on time-axis viz
 *  (time_series, heatmap). Use for deploy/incident/alert annotations. */
export interface PanelAnnotation {
  /** Epoch milliseconds. */
  time: number;
  /** Short label shown in the hover tooltip. */
  label: string;
  /** Optional CSS color string. Defaults to a muted accent. */
  color?: string;
}

export type DashboardStatus = 'generating' | 'ready' | 'failed';

export interface PanelQuery {
  refId: string; // "A", "B", "C"
  expr: string; // PromQL, may contain variables
  legendFormat?: string; // "{{pod}} - {{namespace}}"
  instant?: boolean; // true for stat/gauge
  datasourceId?: string; // which datasource to query (omit = default)
}

export interface PanelThreshold {
  value: number;
  color: string; // "red", "yellow", "green"
  label?: string;
}

/** Point-in-time data captured during an investigation, so panels render
 *  the exact data that was observed rather than live queries. */
export interface PanelSnapshotData {
  /** For range visualizations (time_series, heatmap, status_timeline) */
  range?: Array<{
    refId: string;
    legendFormat?: string;
    series: Array<{ labels: Record<string, string>; points: Array<{ ts: number; value: number }> }>;
    totalSeries: number;
  }>;
  /** For instant visualizations (stat, gauge, bar, pie, histogram) */
  instant?: {
    data: { result: Array<{ metric: Record<string, string>; value: [number, string] }> };
  };
  /** Optional sparkline series (timestamps + values) for stat-panel snapshots
   *  so the trend renders without a follow-up range query. */
  sparkline?: { timestamps: number[]; values: number[] };
  /** ISO timestamp when the data was captured */
  capturedAt: string;
  /** Set when snapshot capture failed (adapter/query error). The panel
   *  rendered without snapshot data; this field tells the UI / operator
   *  why the evidence is empty instead of silently appearing broken. */
  captureError?: string;
}

/** Visual polish fields the agent may emit alongside core panel config.
 *  All optional — when omitted, the frontend applies sensible defaults. */
export type ColorMode = 'value' | 'background' | 'none';
export type GraphMode = 'none' | 'area';
export type ColorScale = 'linear' | 'sqrt' | 'log';
export type LegendStat = 'last' | 'mean' | 'max' | 'min';
export type LegendPlacement = 'bottom' | 'right';

export interface PanelConfig {
  id: string;
  title: string;
  description: string;
  queries?: PanelQuery[]; // multi-query (optional for v1 backward compat)
  visualization: PanelVisualization;
  row: number;
  col: number;
  width: number; // 1-12 (12-column grid)
  height: number;
  refreshIntervalSec?: number | null;
  unit?: string;
  thresholds?: PanelThreshold[];
  stackMode?: 'none' | 'normal' | 'percent';
  fillOpacity?: number;
  decimals?: number;
  // ---- Stat panel polish ----
  /** Show a faint trend sparkline behind the number. Stat panels only. */
  sparkline?: boolean;
  /** Where the resolved threshold color is applied. Stat panels only. */
  colorMode?: ColorMode;
  /** Sparkline render style. */
  graphMode?: GraphMode;
  // ---- Time-series polish ----
  /** Stroke width in CSS pixels. Default 1. */
  lineWidth?: number;
  /** Show point markers ('auto' or 'never'). Default 'never'. */
  showPoints?: 'auto' | 'never';
  /**
   * Y-axis scale type. `undefined` (default) = auto: switch to log when the
   * series spans >3 orders of magnitude. `'linear'` always linear. `'log'`
   * always log (uPlot `distr: 3`).
   */
  yScale?: 'linear' | 'log';
  /** Stats to render inline after each legend entry, in order. */
  legendStats?: LegendStat[];
  /** Legend position relative to the chart. */
  legendPlacement?: LegendPlacement;
  // ---- Heatmap polish ----
  /** Color ramp scale. `'sqrt'` is a safer default than linear for skewed data. */
  colorScale?: ColorScale;
  /** For histogram-mode heatmaps, drop all-zero rows (keeping the lowest
   *  occupied bucket and one row of headroom above the highest occupied
   *  bucket). Default `true` when unset; pass `false` to render every bucket. */
  collapseEmptyBuckets?: boolean;
  // ---- Bar gauge ----
  /** Single ceiling shared by every row in a bar_gauge panel. When unset,
   *  defaults to the largest item value (so each bar fills proportionally). */
  barGaugeMax?: number;
  /** Bar-gauge fill style. Default `'gradient'`. */
  barGaugeMode?: BarGaugeMode;
  // ---- Annotations ----
  /** Event markers rendered as vertical lines on the time axis. Time-series
   *  and heatmap panels use these for deploy/incident/alert overlays. */
  annotations?: PanelAnnotation[];
  // BACKWARD COMPAT: v1 generator produces single query string
  query?: string;
  // Section grouping (from Planner groups)
  sectionId?: string;
  sectionLabel?: string;
  /** Static snapshot data captured during investigation — when set, panel
   *  renders this data instead of executing live PromQL queries. */
  snapshotData?: PanelSnapshotData;
}

export interface DashboardVariable {
  name: string;
  label: string;
  type: 'query' | 'custom' | 'datasource';
  query?: string;
  options?: string[];
  current?: string;
  multi?: boolean;
  includeAll?: boolean;
}

export interface DashboardMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  actions?: DashboardAction[];
  timestamp: string;
}

export type DashboardAction =
  | { type: 'add_panels'; panels: PanelConfig[] }
  | { type: 'remove_panels'; panelIds: string[] }
  | { type: 'modify_panel'; panelId: string; patch: Partial<PanelConfig> }
  | { type: 'rearrange'; layout: Array<{ panelId: string; row: number; col: number; width: number; height: number }> }
  | { type: 'add_variable'; variable: DashboardVariable }
  | { type: 'set_title'; title: string; description?: string }
  | { type: 'create_alert_rule'; ruleId: string; name: string; severity: string; query: string; operator: string; threshold: number; forDurationSec: number; evaluationIntervalSec: number }
  | { type: 'modify_alert_rule'; ruleId: string; patch: { threshold?: number; operator?: string; severity?: string; forDurationSec?: number; evaluationIntervalSec?: number; query?: string; name?: string } }
  | { type: 'delete_alert_rule'; ruleId: string; name?: string };

export interface InvestigationReportSection {
  type: 'text' | 'evidence';
  content: string;
  panel?: PanelConfig;
}

export interface InvestigationReport {
  summary: string;
  sections: InvestigationReportSection[];
}

export interface SavedInvestigationReport {
  id: string;
  dashboardId: string;
  goal: string;
  summary: string;
  sections: InvestigationReportSection[];
  createdAt: string;
  /**
   * Provenance metadata for the AI-generated report (model, runId, toolCalls,
   * evidence count, cost, latency, inline citations). Optional — older rows
   * predate Task 10 and the UI header degrades to "—" for missing fields.
   */
  provenance?: import('./evidence.js').Provenance;
}

/**
 * Proposed-but-not-applied dashboard mutation.
 *
 * AI-driven edits to an existing (already-shared) dashboard are written here
 * first instead of mutating panels/variables directly. The user reviews and
 * accepts/rejects each entry before the change lands. See Task 09.
 *
 * Note: this is a separate surface from Task 06's RiskAwareConfirm — dashboard
 * edits are low-risk and user-driven (`user_conversation` source per Task 05's
 * matrix), so they don't need ActionGuard. The pattern is the same in spirit
 * (preview before apply) but the affordance lives in the dashboard workspace,
 * not the chat confirmation strip.
 */
export type PendingDashboardChangeOp =
  | { kind: 'modify_panel'; panelId: string; patch: Partial<PanelConfig> }
  | { kind: 'remove_panel'; panelId: string }
  | { kind: 'add_variable'; variable: DashboardVariable }
  | { kind: 'modify_variable'; name: string; patch: Partial<DashboardVariable> }
  | { kind: 'remove_variable'; name: string };

export interface PendingDashboardChange {
  /** Stable id for this proposal; used by accept/reject UI to target one row. */
  id: string;
  /** ISO timestamp when the agent proposed this change. */
  proposedAt: string;
  /** `'agent'` for AI-proposed; otherwise the userId of the proposer. */
  proposedBy: string;
  /** Originating chat session id, when known — lets the chat panel link back. */
  sessionId?: string;
  /** Concise human-readable summary, e.g. "Change p1 title to Latency". */
  summary: string;
  /** Machine-readable patch — applied to the live dashboard on accept. */
  op: PendingDashboardChangeOp;
}

export type DashboardSseEvent =
  | { type: 'thinking'; content: string }
  | { type: 'tool_call'; tool: string; args: Record<string, unknown>; displayText: string }
  | { type: 'tool_result'; tool: string; summary: string; success: boolean }
  | { type: 'panel_added'; panel: PanelConfig }
  | { type: 'panel_removed'; panelId: string }
  | { type: 'panel_modified'; panelId: string; patch: Partial<PanelConfig> }
  | { type: 'variable_added'; variable: DashboardVariable }
  | { type: 'pending_changes_proposed'; dashboardId: string; changes: PendingDashboardChange[] }
  | { type: 'investigation_report'; report: InvestigationReport }
  | { type: 'verification_report'; report: { status: string; targetKind: string; summary: string; issues: Array<{ code: string; severity: string; message: string; artifactKind: string; artifactId?: string }>; checksRun: string[] } }
  | { type: 'agent_event'; event: { type: string; agentType: string; timestamp: string; metadata?: Record<string, unknown> } }
  | { type: 'approval_required'; tool: string; args: Record<string, unknown>; displayText: string }
  | { type: 'reply'; content: string }
  | { type: 'ask_user'; question: string; options: Array<{ id: string; label: string; hint?: string }> }
  | {
      // Inline narration of the agent's datasource pick. The chat UI renders
      // a small chip "Using {name} · switch ▼" so the user can override the
      // choice without typing — clicking an alternative submits "option:{id}"
      // back to the agent (same protocol as ask_user buttons).
      type: 'ds_choice';
      chosenId: string;
      name: string;
      reason: string;
      confidence: 'high' | 'medium' | 'low';
      alternatives: Array<{ id: string; name: string; environment?: string; cluster?: string }>;
    }
  | {
      // Inline chart bubble rendered in the chat for throwaway exploration.
      // Emitted by the `metric_explore` agent tool — PR-B renders the chart
      // component from this payload. `series` and `summary` are the same
      // shapes used by the REST endpoint at /api/metrics/query.
      type: 'inline_chart';
      query: string;
      datasourceId: string;
      timeRange: { start: string; end: string };
      step: string;
      metricKind: 'latency' | 'counter' | 'gauge' | 'errors';
      series: Array<{ metric: Record<string, string>; values: Array<[number, string]> }>;
      summary: { kind: 'latency' | 'counter' | 'gauge' | 'errors'; oneLine: string; stats: Record<string, number | string> };
      // PR-C will populate pivot suggestions ("by route", "p99 only", etc).
      // Empty array in v1 so the frontend can render the affordance shape stably.
      pivotSuggestions: Array<{ id: string; label: string }>;
    }
  | { type: 'done'; messageId: string }
  | { type: 'error'; message: string };

export type DashboardType = 'dashboard';

export interface Dashboard {
  id: string;
  type: DashboardType;
  title: string;
  description: string;
  prompt: string;
  userId: string;
  status: DashboardStatus;
  panels: PanelConfig[];
  variables: DashboardVariable[];
  refreshIntervalSec: number;
  datasourceIds: string[];
  // When true (default), discovery probes Prometheus for existing metrics. When false, panels are built from best-practice conventions only.
  useExistingMetrics: boolean;
  folder?: string;
  workspaceId?: string;
  version?: number;
  publishStatus?: PublishStatus;
  createdAt: string;
  updatedAt: string;
  error?: string;
  /**
   * Origin of the dashboard. Drives the writable-gate check —
   * provisioned_file / provisioned_git rows refuse mutations from REST
   * endpoints and agent tools. See packages/common/src/resources/writable-gate.ts.
   *
   * Repositories populate this on read (defaulting to `'manual'`); marked
   * optional so existing in-memory fixtures / mocks compile without a churn.
   * Treat absence as `'manual'` at call sites.
   */
  source?: ResourceSource;
  /** Optional details about how the dashboard was provisioned. */
  provenance?: ResourceProvenance;
  /**
   * AI-proposed modifications that have NOT been applied yet. Empty/undefined
   * for dashboards with no outstanding proposals. The dashboard workspace UI
   * surfaces these through PendingChangesBar; user must accept before the
   * shared dashboard is mutated. See `PendingDashboardChange`.
   */
  pendingChanges?: PendingDashboardChange[];
}

// -- Chat session types

export interface ChatSession {
  id: string;
  title: string;
  orgId?: string;
  ownerUserId?: string | null;
  createdAt: string;
  updatedAt: string;
  /** LLM-generated summary of older conversation turns for context compaction */
  contextSummary?: string;
}

export type ChatSessionContextResourceType = 'dashboard' | 'investigation' | 'alert';
export type ChatSessionContextRelation =
  | 'created_from_chat'
  | 'viewed_with_chat'
  | 'referenced';

export interface ChatSessionContext {
  id: string;
  sessionId: string;
  orgId: string;
  ownerUserId: string;
  resourceType: ChatSessionContextResourceType;
  resourceId: string;
  relation: ChatSessionContextRelation;
  createdAt: string;
}

export interface ChatMessage {
  id: string;
  sessionId: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  actions?: DashboardAction[];
  timestamp: string;
}
