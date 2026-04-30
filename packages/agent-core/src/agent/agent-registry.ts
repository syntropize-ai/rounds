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
    // Investigation lifecycle
    'investigation_create', 'investigation_list',
    'investigation_add_section',
    'investigation_complete',
    // Datasource discovery (always allowed; no RBAC)
    'datasources_list',
    'datasources_suggest', 'datasources_pin', 'datasources_unpin',
    // Source-agnostic metrics primitives (each requires sourceId)
    'metrics_query', 'metrics_range_query', 'metrics_discover', 'metrics_validate',
    // Source-agnostic logs primitives (each requires sourceId)
    'logs_query', 'logs_labels', 'logs_label_values',
    // Recent change events
    'changes_list_recent',
    // Kubernetes / Ops integrations (requires configured connector + RBAC)
    'ops_run_command',
    // Knowledge
    'web_search',
    // Alert rules
    'alert_rule_write', 'alert_rule_list', 'alert_rule_history',
    // Navigation
    'navigate',
    // Lazy tool loading — fetches deferred schemas on demand
    'tool_search',
  ],
  inputKinds: ['dashboard'],
  outputKinds: ['dashboard', 'panel', 'dashboard_variable', 'investigation_report', 'alert_rule'],
  permissionMode: 'artifact_mutation',
  maxIterations: 30,
});

agentRegistry.register({
  type: 'alert-rule-builder',
  description: 'Generates alert rules from natural language, using dashboard context and metric discovery',
  // tool_search is required so this narrow agent can load any tool that's
  // marked deferred in the registry. Without it the deferred tools listed
  // here (metrics_discover) would be unloadable on a fresh turn — the
  // schema is only surfaced after a tool_search call.
  allowedTools: ['alert_rule_write', 'metrics_query', 'metrics_discover', 'llm.complete', 'tool_search'],
  inputKinds: ['dashboard', 'panel'],
  outputKinds: ['alert_rule'],
  permissionMode: 'propose_only',
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
