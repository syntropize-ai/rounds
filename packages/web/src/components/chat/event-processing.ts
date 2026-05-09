import { redactParamsForAudit } from '@agentic-obs/common';
import type { ChatEvent } from '../../hooks/useDashboardChat.js';

// Block grouping

interface MessageBlock {
  type: 'message';
  event: ChatEvent;
}
interface AgentBlock {
  type: 'agent';
  events: ChatEvent[];
  id: string;
}
export type Block = MessageBlock | AgentBlock;

export function groupEvents(events: ChatEvent[]): Block[] {
  const blocks: Block[] = [];
  let currentAgent: ChatEvent[] = [];

  const flushAgent = () => {
    if (currentAgent.length > 0) {
      blocks.push({ type: 'agent', events: [...currentAgent], id: currentAgent[0]!.id });
      currentAgent = [];
    }
  };

  for (const evt of events) {
    if (evt.kind === 'message' || evt.kind === 'error' || evt.kind === 'ask_user' || evt.kind === 'ds_choice') {
      flushAgent();
      blocks.push({ type: 'message', event: evt });
    } else if (evt.kind === 'done') {
      flushAgent();
    } else {
      currentAgent.push(evt);
    }
  }

  flushAgent();
  return blocks;
}

// Step processing

// Phase-grouped step builder.
// Multiple tool events that belong to the same phase merge into one step
// with in-place status updates instead of adding new rows.

export interface StepRow {
  id: string;
  phase: string;
  label: string;
  status: string;
  result?: { text: string; success: boolean };
  done: boolean;
  subStepCount: number;
}

/**
 * Per-tool-call card (Task 11). One card per `tool_call` event, paired with
 * its matching `tool_result` (when one arrives). Unlike `StepRow` these are
 * NOT merged by phase — five `metrics_query` calls render five cards.
 */
export interface ToolCallCard {
  id: string;
  tool: string;
  label: string;
  /** 'running' until paired result, then 'done' or 'error' */
  status: 'running' | 'done' | 'error';
  /** Sanitized input args (secrets redacted). Undefined if event had no args. */
  params?: Record<string, unknown>;
  /** Full output text (server-provided; server may not emit yet). */
  output?: string;
  /** Result summary text (always present once result arrives). */
  summary?: string;
  evidenceId?: string;
  cost?: number;
  durationMs?: number;
}

export const USER_VISIBLE_TOOLS = new Set([
  // Orchestrator-level actions
  'generate_dashboard',
  'add_panels',
  'remove_panels',
  'modify_panel',
  'rearrange',
  'add_variable',
  'set_title',
  'investigate',
  // Dashboard generation sub-phases (legacy composite pipeline)
  'research',
  'web_search',
  'discover',
  'discover_metrics',
  'discover_labels',
  'sample_metrics',
  'fetch_metadata',
  'planner',
  'build_progress',
  'validate_query',
  'fix_query',
  'critic',
  // Investigation sub-phases
  'investigate_plan',
  'investigate_query',
  'investigate_analyze',
  // Data source discovery
  'datasources_list',
  'datasources_suggest',
  'datasources_pin',
  'datasources_unpin',
  // Metrics primitives (runtime-first toolized access, source-agnostic)
  'metrics_query',
  'metrics_range_query',
  'metrics_discover',
  'metrics_validate',
  // Logs primitives
  'logs_query',
  'logs_labels',
  'logs_label_values',
  // Changes / deployment events
  'changes_list_recent',
  // Dashboard mutation primitives
  'dashboard_create',
  'dashboard_list',
  'dashboard_clone',
  'dashboard_add_panels',
  'dashboard_remove_panels',
  'dashboard_modify_panel',
  'dashboard_rearrange',
  'dashboard_add_variable',
  'dashboard_set_title',
  // Investigation primitives
  'investigation_create',
  'investigation_list',
  'investigation_add_section',
  'investigation_complete',
  // Alert rule primitives — write covers create/update/delete via `op`
  'alert_rule_write',
  'alert_rule_list',
  'alert_rule_history',
  // Web search primitive
  'web_search',
  // Ops connector — single entrypoint for kubectl/cluster commands
  'ops_run_command',
  // Lazy tool loading — surfaces deferred tool schemas on demand
  'tool_search',
]);

/**
 * Derive a phase key from a tool name.
 * Tools sharing a phase merge into one step row.
 * Convention: tool names with common prefix group together.
 */
export function phaseOf(tool: string): string {
  // Data source discovery
  if (
    tool === 'datasources_list' ||
    tool === 'datasources_suggest' ||
    tool === 'datasources_pin' ||
    tool === 'datasources_unpin'
  ) return 'discover';

  // Metrics primitives — discover (kind=labels/values/series/metadata/names)
  // collapses into one phase; query / validate stay distinct.
  if (tool === 'metrics_discover') return 'discover';
  if (tool === 'metrics_query' || tool === 'metrics_range_query') return 'query';
  if (tool === 'metrics_validate') return 'validate';

  // Logs primitives — same split as metrics
  if (tool === 'logs_labels' || tool === 'logs_label_values') return 'discover';
  if (tool === 'logs_query') return 'query';

  // Changes / deployment events
  if (tool === 'changes_list_recent') return 'discover';

  // Dashboard mutation primitives — list is read-only discovery
  if (tool === 'dashboard_list') return 'discover';
  if (tool.startsWith('dashboard.')) return 'dashboard';

  // Investigation primitives
  if (tool === 'investigation_list') return 'discover';
  if (tool.startsWith('investigation.')) return 'investigate';

  // Alert rule primitives — read-only listing groups under discover; write is its own phase
  if (tool === 'alert_rule_list' || tool === 'alert_rule_history') return 'discover';
  if (tool === 'alert_rule_write') return 'alert_rule';

  // Web search
  if (tool === 'web_search') return 'research';

  // Ops / cluster commands
  if (tool === 'ops_run_command') return 'ops';

  // Lazy tool loading
  if (tool === 'tool_search') return 'discover';

  // Legacy composite pipeline phases
  if (tool === 'sample_metrics') return 'discover';
  if (tool === 'validate_query' || tool === 'fix_query') return 'generate';
  if (tool === 'critic' || tool === 'build_progress') return 'generate';

  // Underscore-delimited prefix grouping for remaining tools
  const parts = tool.split('_');
  return parts.length > 1 ? parts.slice(0, -1).join('_') : tool;
}

export const TOOL_LABELS: Record<string, string> = {
  // Dashboard generation phases (legacy composite)
  research: 'Researching',
  web_search: 'Researching',
  discover: 'Discovering metrics',
  discover_metrics: 'Discovering metrics',
  discover_labels: 'Discovering labels',
  sample_metrics: 'Sampling metrics',
  fetch_metadata: 'Fetching metadata',
  planner: 'Planning dashboard',
  build_progress: 'Building panels',
  generate_dashboard: 'Generating dashboard',
  validate_query: 'Validating queries',
  fix_query: 'Fixing queries',
  critic: 'Reviewing panels',
  // Data source discovery
  'datasources_list': 'Listing data sources',
  'datasources_suggest': 'Choosing data source',
  'datasources_pin': 'Pinning data source',
  'datasources_unpin': 'Unpinning data source',
  // Metrics primitives (source-agnostic)
  'metrics_query': 'Querying metrics',
  'metrics_range_query': 'Range-querying metrics',
  'metrics_discover': 'Discovering metrics',
  'metrics_validate': 'Validating query',
  // Logs primitives
  'logs_query': 'Searching logs',
  'logs_labels': 'Listing log labels',
  'logs_label_values': 'Listing log label values',
  // Changes / deployment events
  'changes_list_recent': 'Checking recent changes',
  // Dashboard mutation primitives
  'dashboard_create': 'Creating dashboard',
  'dashboard_list': 'Listing dashboards',
  'dashboard_clone': 'Cloning dashboard',
  'dashboard_add_panels': 'Adding panels',
  'dashboard_remove_panels': 'Removing panels',
  'dashboard_modify_panel': 'Modifying panel',
  'dashboard_rearrange': 'Rearranging layout',
  'dashboard_add_variable': 'Adding variable',
  'dashboard_set_title': 'Setting title',
  // Investigation primitives
  'investigation_create': 'Creating investigation',
  'investigation_list': 'Listing investigations',
  'investigation_add_section': 'Adding investigation section',
  'investigation_complete': 'Completing investigation',
  // Alert rule primitives — write covers create/update/delete via `op`
  'alert_rule_write': 'Writing alert rule',
  'alert_rule_list': 'Listing alerts',
  'alert_rule_history': 'Checking alert history',
  // Ops connector (kubectl etc.)
  'ops_run_command': 'Running ops command',
  // Lazy tool loading
  'tool_search': 'Loading tool',
  // Panel operations
  add_panels: 'Adding panels',
  remove_panels: 'Removing panels',
  modify_panel: 'Modifying panel',
  rearrange: 'Rearranging layout',
  add_variable: 'Adding variable',
  set_title: 'Setting title',
  // Investigation
  investigate: 'Investigating',
  investigate_plan: 'Planning investigation',
  investigate_query: 'Querying Prometheus',
  investigate_analyze: 'Analyzing evidence',
  // Alerts
  create_alert_rule: 'Creating alert',
  modify_alert_rule: 'Updating alert',
  delete_alert_rule: 'Deleting alert',
};

export function buildSteps(events: ChatEvent[]): { steps: StepRow[]; preStatus: string | null } {
  const steps: StepRow[] = [];
  const phaseMap = new Map<string, StepRow>();
  let preStatus: string | null = null;

  for (const evt of events) {
    if (evt.kind === 'thinking') {
      const active = [...steps].reverse().find((s) => !s.done);
      if (active) {
        active.status = evt.content ?? active.status;
      } else {
        preStatus = evt.content ?? null;
      }
      continue;
    }

    if (evt.kind === 'tool_call') {
      const tool = evt.tool ?? 'unknown';
      if (!USER_VISIBLE_TOOLS.has(tool)) {
        continue;
      }
      const phase = phaseOf(tool);
      const displayText = evt.content ?? TOOL_LABELS[tool] ?? tool;

      const existing = phaseMap.get(phase);
      if (existing && !existing.done) {
        // In-place update: same phase, just update status
        existing.status = displayText;
        existing.subStepCount++;
      } else {
        // New phase → new step row
        const step: StepRow = {
          id: evt.id,
          phase,
          label: displayText,
          status: displayText,
          done: false,
          subStepCount: 1,
        };
        steps.push(step);
        phaseMap.set(phase, step);
      }
      continue;
    }

    if (evt.kind === 'tool_result') {
      const tool = evt.tool ?? 'unknown';
      if (!USER_VISIBLE_TOOLS.has(tool)) {
        continue;
      }
      const phase = phaseOf(tool);
      const match = phaseMap.get(phase);
      if (match) {
        match.status = evt.content ?? match.status;
        // Phase is done when a "summary" result arrives (not intermediate progress)
        // Mark done if the result's tool matches the phase directly
        if (tool === phase || match.subStepCount <= 1) {
          match.result = { text: evt.content ?? '', success: evt.success !== false };
          match.done = true;
        }
      }
      continue;
    }
  }

  return { steps, preStatus };
}

/**
 * Build one card per user-visible tool_call event. Each card pairs to the
 * NEXT matching tool_result for the same tool name (FIFO within a tool).
 *
 * This is intentionally per-call (not phase-merged) so users see every step
 * the agent ran — five `metrics_query` calls produce five cards.
 */
export function buildToolCalls(events: ChatEvent[]): ToolCallCard[] {
  const cards: ToolCallCard[] = [];
  // For each tool name, queue of indices of cards still awaiting a result.
  const pending = new Map<string, number[]>();

  for (const evt of events) {
    if (evt.kind === 'tool_call') {
      const tool = evt.tool ?? 'unknown';
      if (!USER_VISIBLE_TOOLS.has(tool)) continue;
      const label = TOOL_LABELS[tool] ?? tool;
      const card: ToolCallCard = {
        id: evt.id,
        tool,
        label,
        status: 'running',
        ...(evt.params ? { params: redactParamsForAudit(evt.params) } : {}),
        ...(evt.evidenceId ? { evidenceId: evt.evidenceId } : {}),
      };
      const idx = cards.push(card) - 1;
      const queue = pending.get(tool) ?? [];
      queue.push(idx);
      pending.set(tool, queue);
      continue;
    }

    if (evt.kind === 'tool_result') {
      const tool = evt.tool ?? 'unknown';
      if (!USER_VISIBLE_TOOLS.has(tool)) continue;
      const queue = pending.get(tool);
      if (!queue || queue.length === 0) continue;
      const idx = queue.shift()!;
      const card = cards[idx];
      if (!card) continue;
      card.status = evt.success === false ? 'error' : 'done';
      if (evt.content) card.summary = evt.content;
      if (evt.output) card.output = evt.output;
      if (evt.evidenceId && !card.evidenceId) card.evidenceId = evt.evidenceId;
      if (typeof evt.cost === 'number') card.cost = evt.cost;
      if (typeof evt.durationMs === 'number') card.durationMs = evt.durationMs;
      continue;
    }
  }

  return cards;
}
