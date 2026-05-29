import type { AgentType } from './agent-types.js';
import type { AgentDefinition } from './agent-definition.js';

class AgentRegistry {
  private readonly definitions = new Map<AgentType, AgentDefinition>();

  register(def: AgentDefinition): void {
    this.definitions.set(def.type, def);
  }

  get(type: AgentType): AgentDefinition | undefined {
    return this.definitions.get(type);
  }

  getAll(): AgentDefinition[] {
    return Array.from(this.definitions.values());
  }

  has(type: AgentType): boolean {
    return this.definitions.has(type);
  }
}

export const agentRegistry = new AgentRegistry();

// -- Pre-register all built-in agents --

agentRegistry.register({
  type: 'orchestrator',
  description: 'Autonomous observability agent that uses primitive tools to build dashboards, investigate issues, and manage alerts',
  allowedTools: [
    // Dashboard lifecycle + mutation primitives
    'dashboard_create', 'dashboard_list', 'dashboard_clone',
    'dashboard_add_panels', 'dashboard_remove_panels', 'dashboard_modify_panel',
    // NOTE: 'dashboard_rearrange' was listed here historically but no handler
    // exists in orchestrator-action-handlers.ts (only the action-executor
    // applies a 'rearrange' action internally for layout). Until a real
    // handler lands, keep it out of the LLM-facing tool surface.
    'dashboard_add_variable', 'dashboard_set_title',
    // Dashboard lint — pluggable rule engine, read-only
    'dashboard_lint',
    // Folder lifecycle
    'folder_create', 'folder_list',
    // Investigation lifecycle
    'investigation_create', 'investigation_list',
    'investigation_add_text', 'investigation_add_evidence',
    'investigation_complete',
    // Connector discovery (always allowed; no RBAC)
    'connectors_list',
    'connectors_suggest', 'connectors_pin', 'connectors_unpin',
    // Source-agnostic metrics primitives (each requires sourceId)
    'metrics_query', 'metrics_range_query', 'metrics_discover', 'metrics_validate',
    // Narrow per-shape discovery primitives — preferred over metrics_discover
    // for new flows (one tool name = one intent).
    'metrics_list_names', 'metrics_get_labels', 'metrics_get_label_values',
    'metrics_get_cardinality', 'metrics_sample_series', 'metrics_find_related',
    // Inline chart bubble in chat — for "show me / what is" type questions.
    'metric_explore',
    // Panel preview — server-side renders + validates a single panel spec.
    'panel_preview',
    // Source-agnostic logs primitives (each requires sourceId)
    'logs_query', 'logs_labels', 'logs_label_values',
    // Recent change events
    'changes_list_recent',
    // Kubernetes / Ops integrations (requires configured connector + RBAC)
    'ops_run_command', 'ops_cluster_shell',
    // GitHub VCS read tools (requires configured GitHub connector + RBAC)
    'github_list_repos', 'github_list_prs', 'github_get_pr', 'github_get_diff',
    // Knowledge
    'web_search',
    // Knowledge base — hybrid retrieval + bundled seeds
    'kb_search', 'kb_get', 'kb_recommend',
    // Alert rules
    'alert_rule_write', 'alert_rule_list', 'alert_rule_history',
    // Navigation
    'navigate',
    // Connector-model setup and allowlisted settings.
    'connector_list', 'connector_template_list', 'connector_detect',
    'connector_propose', 'connector_apply', 'connector_test',
    'setting_get', 'setting_set',
    // Lazy tool loading — fetches deferred schemas on demand
    'tool_search',
    // On-demand task-context module loading — splits the system prompt
    'load_task_context',
    // Clarifying question — terminal tool handled inside ReActLoop
    'ask_user',
  ],
  inputKinds: ['dashboard'],
  outputKinds: ['dashboard', 'panel', 'dashboard_variable', 'investigation_report', 'alert_rule'],
  permissionMode: 'artifact_mutation',
  maxIterations: 30,
});

const foregroundOrchestrator = agentRegistry.get('orchestrator')!;

agentRegistry.register({
  ...foregroundOrchestrator,
  type: 'background_orchestrator',
  description: 'Background observability agent for alert-triggered investigations and remediation-plan proposals',
  allowedTools: [
    ...foregroundOrchestrator.allowedTools,
    // Remediation plans are background-only. Interactive chat uses
    // permission + confirmation + execution, not formal approvals.
    'remediation_plan_create',
    'remediation_plan_create_rescue',
  ],
  canRunInBackground: true,
});

agentRegistry.register({
  type: 'verification',
  description: 'Verifies generated artifacts (dashboards, investigation reports, alert rules) meet quality standards',
  allowedTools: ['verifier.run', 'metrics_query', 'llm.complete'],
  inputKinds: ['dashboard', 'investigation_report', 'alert_rule'],
  outputKinds: [],
  permissionMode: 'read_only',
  canRunInBackground: true,
});
