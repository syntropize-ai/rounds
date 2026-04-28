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
    'dashboard.create', 'dashboard.list', 'dashboard.clone',
    'dashboard.add_panels', 'dashboard.remove_panels', 'dashboard.modify_panel',
    // NOTE: 'dashboard.rearrange' was listed here historically but no handler
    // exists in orchestrator-action-handlers.ts (only the action-executor
    // applies a 'rearrange' action internally for layout). Until a real
    // handler lands, keep it out of the LLM-facing tool surface.
    'dashboard.add_variable', 'dashboard.set_title',
    // Investigation lifecycle
    'investigation.create', 'investigation.list',
    'investigation.add_section',
    'investigation.complete',
    // Datasource discovery (always allowed; no RBAC)
    'datasources.list',
    'datasources.suggest', 'datasources.pin', 'datasources.unpin',
    // Source-agnostic metrics primitives (each requires sourceId)
    'metrics.query', 'metrics.range_query', 'metrics.discover', 'metrics.validate',
    // Source-agnostic logs primitives (each requires sourceId)
    'logs.query', 'logs.labels', 'logs.label_values',
    // Recent change events
    'changes.list_recent',
    // Kubernetes / Ops integrations (requires configured connector + RBAC)
    'ops.run_command',
    // Knowledge
    'web.search',
    // Alert rules
    'alert_rule.write', 'alert_rule.list', 'alert_rule.history',
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
  // here (metrics.discover) would be unloadable on a fresh turn — the
  // schema is only surfaced after a tool_search call.
  allowedTools: ['alert_rule.write', 'metrics.query', 'metrics.discover', 'llm.complete', 'tool_search'],
  inputKinds: ['dashboard', 'panel'],
  outputKinds: ['alert_rule'],
  permissionMode: 'propose_only',
});

agentRegistry.register({
  type: 'verification',
  description: 'Verifies generated artifacts (dashboards, investigation reports, alert rules) meet quality standards',
  allowedTools: ['verifier.run', 'metrics.query', 'llm.complete'],
  inputKinds: ['dashboard', 'investigation_report', 'alert_rule'],
  outputKinds: [],
  permissionMode: 'read_only',
  canRunInBackground: true,
});
