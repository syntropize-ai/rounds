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

export type ProposalStatusMap = Record<string, 'pending' | 'accepted' | 'rejected' | 'expired'>;

export function groupEvents(
  events: ChatEvent[],
  proposalStatus: ProposalStatusMap = {},
  opsStatusOverlay: Map<string, NonNullable<ChatEvent['opsConfirmation']>> = new Map(),
): Block[] {
  const blocks: Block[] = [];
  let currentAgent: ChatEvent[] = [];
  const opsStatus = new Map<
    string,
    NonNullable<ChatEvent['opsConfirmation']>
  >();

  for (const evt of events) {
    if (evt.kind === 'ops_command_confirmation_resolved' && evt.opsConfirmation?.id) {
      opsStatus.set(evt.opsConfirmation.id, evt.opsConfirmation);
    }
  }
  for (const [id, status] of opsStatusOverlay) {
    opsStatus.set(id, status);
  }

  const flushAgent = () => {
    if (currentAgent.length > 0) {
      blocks.push({ type: 'agent', events: [...currentAgent], id: currentAgent[0]!.id });
      currentAgent = [];
    }
  };

  for (const evt of events) {
    if (
      evt.kind === 'message' ||
      evt.kind === 'error' ||
      evt.kind === 'ask_user' ||
      evt.kind === 'ds_choice' ||
      evt.kind === 'inline_chart' ||
      evt.kind === 'pending_change_created' ||
      evt.kind === 'ops_command_confirmation_required'
    ) {
      flushAgent();
      blocks.push({ type: 'message', event: evt });

      if (evt.kind === 'pending_change_created') {
        const proposalId =
          (evt as { pendingChange?: { id?: string } }).pendingChange?.id;
        const status = proposalId ? proposalStatus[proposalId] : undefined;
        const isUnresolved = !status || status === 'pending';
        if (isUnresolved) {
          return blocks;
        }
      }
      if (evt.kind === 'ops_command_confirmation_required' && evt.opsConfirmation?.id) {
        const resolved = opsStatus.get(evt.opsConfirmation.id);
        if (resolved || evt.opsConfirmation.status !== 'pending') {
          const block = blocks[blocks.length - 1];
          if (block?.type === 'message') {
            block.event = {
              ...block.event,
              opsConfirmation: {
                ...evt.opsConfirmation,
                ...(resolved ?? {}),
                connectorId: evt.opsConfirmation.connectorId,
                command: evt.opsConfirmation.command,
              },
            };
          }
        } else {
          return blocks;
        }
      }
    } else if (evt.kind === 'pending_change_resolved' || evt.kind === 'ops_command_confirmation_resolved') {
      // Resolution events don't render their own block; the corresponding
      // confirmation card overlays its status via the page-level overlay map.
      continue;
    } else if (evt.kind === 'done') {
      flushAgent();
    } else {
      currentAgent.push(evt);
    }
  }

  flushAgent();
  return blocks;
}

export function liveAgentBlockId(blocks: Block[], isGenerating: boolean): string | null {
  if (!isGenerating) return null;
  const last = blocks[blocks.length - 1];
  return last?.type === 'agent' ? last.id : null;
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
  /** 'running' until the paired tool_result arrives, then 'done'. There is
   *  no 'error' state — the agent reasons over the observation text, and a
   *  red X in the transcript would just nudge a human reader to over-index
   *  on tool exit codes / non-zero shell returns / empty result sets. */
  status: 'running' | 'done';
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

export interface ToolActivityGroup {
  id: string;
  phase: string;
  tool: string;
  label: string;
  status: ToolCallCard['status'];
  count: number;
  params?: Record<string, unknown>;
  output?: string;
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
  'connectors_list',
  'connectors_suggest',
  'connectors_pin',
  'connectors_unpin',
  // Connector setup
  'connector_list',
  'connector_template_list',
  'connector_detect',
  'connector_propose',
  'connector_apply',
  'connector_test',
  'setting_get',
  'setting_set',
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
  // Knowledge-base primitives — bundled + saved skill-style entries
  'kb_search',
  'kb_get',
  'kb_recommend',
  // Ops connector — single entrypoint for kubectl/cluster commands
  'ops_run_command',
  'ops_cluster_shell',
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
    tool === 'connectors_list' ||
    tool === 'connectors_suggest' ||
    tool === 'connectors_pin' ||
    tool === 'connectors_unpin'
  ) return 'discover';

  if (tool.startsWith('connector_')) return 'connector';
  if (tool.startsWith('setting_')) return 'setting';

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

  // Knowledge base — kb_recommend / kb_search are discovery, kb_get is a fetch
  if (tool === 'kb_recommend' || tool === 'kb_search') return 'kb_lookup';
  if (tool === 'kb_get') return 'kb_fetch';

  // Ops / cluster commands
  if (tool === 'ops_run_command' || tool === 'ops_cluster_shell') return 'ops';

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
  'connectors_list': 'Listing connectors',
  'connectors_suggest': 'Choosing connector',
  'connectors_pin': 'Pinning connector',
  'connectors_unpin': 'Unpinning connector',
  'connector_list': 'Listing connectors',
  'connector_template_list': 'Listing connector templates',
  'connector_detect': 'Detecting connectors',
  'connector_propose': 'Proposing connector',
  'connector_apply': 'Applying connector',
  'connector_test': 'Testing connector',
  'setting_get': 'Reading setting',
  'setting_set': 'Updating setting',
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
  // Knowledge base
  'kb_search': 'Searching knowledge',
  'kb_get': 'Reading knowledge entry',
  'kb_recommend': 'Looking up skills',
  'kb_lookup': 'Looking up skills',
  'kb_fetch': 'Reading knowledge entry',
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
  'ops_cluster_shell': 'Preparing cluster command',
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
        // Mark done if the result's tool matches the phase directly. `success`
        // on the event is ignored — the UI no longer colours steps as
        // pass/fail; the observation text speaks for itself.
        if (tool === phase || match.subStepCount <= 1) {
          match.result = { text: evt.content ?? '', success: true };
          match.done = true;
        }
      }
      continue;
    }
  }

  return { steps, preStatus };
}

/**
 * Build one data object per user-visible tool_call event. Each card pairs to
 * the NEXT matching tool_result for the same tool name (FIFO within a tool).
 *
 * The chat UI should group these for display; this lower-level shape stays
 * per-call so audit/debug surfaces can still inspect exact tool activity.
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
      // `evt.success` is ignored: the agent reasons over the observation
      // text, not a boolean — and the UI's pulsing/static dot only conveys
      // "in flight vs done", not "passed vs failed".
      card.status = 'done';
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

export function buildToolActivityGroups(events: ChatEvent[]): ToolActivityGroup[] {
  const groups: ToolActivityGroup[] = [];
  const byPhase = new Map<string, ToolActivityGroup>();

  for (const card of buildToolCalls(events)) {
    const phase = phaseOf(card.tool);
    const existing = byPhase.get(phase);
    if (!existing) {
      const group: ToolActivityGroup = {
        id: card.id,
        phase,
        tool: card.tool,
        label: TOOL_LABELS[phase] ?? card.label,
        status: card.status,
        count: 1,
        ...(card.params ? { params: card.params } : {}),
        ...(card.output ? { output: card.output } : {}),
        ...(card.summary ? { summary: card.summary } : {}),
        ...(card.evidenceId ? { evidenceId: card.evidenceId } : {}),
        ...(typeof card.cost === 'number' ? { cost: card.cost } : {}),
        ...(typeof card.durationMs === 'number' ? { durationMs: card.durationMs } : {}),
      };
      groups.push(group);
      byPhase.set(phase, group);
      continue;
    }

    existing.count += 1;
    existing.tool = card.tool;
    existing.label = TOOL_LABELS[phase] ?? card.label;
    // Group status: pulses while ANY of its cards is running, otherwise done.
    existing.status = card.status === 'running' ? 'running' : existing.status === 'running' ? 'running' : 'done';
    if (card.params) existing.params = card.params;
    if (card.output) existing.output = card.output;
    if (card.summary) existing.summary = card.summary;
    if (card.evidenceId) existing.evidenceId = card.evidenceId;
    if (typeof card.cost === 'number') existing.cost = (existing.cost ?? 0) + card.cost;
    if (typeof card.durationMs === 'number') {
      existing.durationMs = (existing.durationMs ?? 0) + card.durationMs;
    }
  }

  return groups;
}
