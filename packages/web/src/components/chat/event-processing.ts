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
    if (evt.kind === 'message' || evt.kind === 'error') {
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
  'create_alert_rule',
  'modify_alert_rule',
  'delete_alert_rule',
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
  'datasources.list',
  // Metrics primitives (runtime-first toolized access, source-agnostic)
  'metrics.query',
  'metrics.range_query',
  'metrics.labels',
  'metrics.label_values',
  'metrics.series',
  'metrics.metadata',
  'metrics.metric_names',
  'metrics.validate',
  // Logs primitives
  'logs.query',
  'logs.labels',
  'logs.label_values',
  // Changes / deployment events
  'changes.list_recent',
  // Dashboard mutation primitives
  'dashboard.add_panels',
  'dashboard.remove_panels',
  'dashboard.modify_panel',
  'dashboard.rearrange',
  'dashboard.add_variable',
  'dashboard.set_title',
  // Web search primitive
  'web_search',
]);

/**
 * Derive a phase key from a tool name.
 * Tools sharing a phase merge into one step row.
 * Convention: tool names with common prefix group together.
 */
export function phaseOf(tool: string): string {
  // Data source discovery
  if (tool === 'datasources.list') return 'discover';

  // Metrics primitives — group by activity type (mirrors old prometheus mapping 1:1)
  if (tool === 'metrics.metric_names' || tool === 'metrics.series' || tool === 'metrics.metadata') return 'discover';
  if (tool === 'metrics.labels' || tool === 'metrics.label_values') return 'discover';
  if (tool === 'metrics.query' || tool === 'metrics.range_query') return 'query';
  if (tool === 'metrics.validate') return 'validate';

  // Logs primitives — same split as metrics
  if (tool === 'logs.labels' || tool === 'logs.label_values') return 'discover';
  if (tool === 'logs.query') return 'query';

  // Changes / deployment events
  if (tool === 'changes.list_recent') return 'discover';

  // Dashboard mutation primitives
  if (tool.startsWith('dashboard.')) return 'dashboard';

  // Web search
  if (tool === 'web_search' || tool === 'web.search') return 'research';

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
  'datasources.list': 'Listing data sources',
  // Metrics primitives (source-agnostic)
  'metrics.query': 'Querying metrics',
  'metrics.range_query': 'Range-querying metrics',
  'metrics.labels': 'Listing metric labels',
  'metrics.label_values': 'Listing label values',
  'metrics.series': 'Finding metric series',
  'metrics.metadata': 'Fetching metric metadata',
  'metrics.metric_names': 'Listing metric names',
  'metrics.validate': 'Validating query',
  // Logs primitives
  'logs.query': 'Searching logs',
  'logs.labels': 'Listing log labels',
  'logs.label_values': 'Listing log label values',
  // Changes / deployment events
  'changes.list_recent': 'Checking recent changes',
  // Dashboard mutation primitives
  'dashboard.add_panels': 'Adding panels',
  'dashboard.remove_panels': 'Removing panels',
  'dashboard.modify_panel': 'Modifying panel',
  'dashboard.rearrange': 'Rearranging layout',
  'dashboard.add_variable': 'Adding variable',
  'dashboard.set_title': 'Setting title',
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
