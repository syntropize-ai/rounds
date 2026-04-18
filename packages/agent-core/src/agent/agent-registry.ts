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
    'dashboard.create', 'dashboard.list',
    'dashboard.add_panels', 'dashboard.remove_panels', 'dashboard.modify_panel',
    'dashboard.rearrange', 'dashboard.add_variable', 'dashboard.set_title',
    // Investigation lifecycle
    'investigation.create', 'investigation.list',
    'investigation.add_section',
    'investigation.complete',
    // Prometheus primitives
    'prometheus.query', 'prometheus.range_query', 'prometheus.labels', 'prometheus.label_values',
    'prometheus.series', 'prometheus.metadata', 'prometheus.metric_names', 'prometheus.validate',
    // Knowledge
    'web.search',
    // Alert rules
    'create_alert_rule', 'modify_alert_rule', 'delete_alert_rule',
    'alert_rule.list', 'alert_rule.history',
    // Navigation
    'navigate',
  ],
  inputKinds: ['dashboard'],
  outputKinds: ['dashboard', 'panel', 'dashboard_variable', 'investigation_report', 'alert_rule'],
  permissionMode: 'artifact_mutation',
  maxIterations: 30,
});

// -- Wave 7 specialized agents ---------------------------------------------
// Each has a narrower allowedTools ceiling (Layer 1 of the permission gate).
// The chat entry point picks one based on page context; the orchestrator
// remains the superset agent for the full session-mode chat.

agentRegistry.register({
  type: 'readonly-analyst',
  description: 'Read-only analyst — lists, reads, and Prometheus queries. No mutations of any kind.',
  allowedTools: [
    // All list/read tools
    'dashboard.list',
    'folder.list',
    'investigation.list',
    'alert_rule.list', 'alert_rule.history',
    // Prometheus primitives — read-only by nature
    'prometheus.query', 'prometheus.range_query', 'prometheus.labels', 'prometheus.label_values',
    'prometheus.series', 'prometheus.metadata', 'prometheus.metric_names', 'prometheus.validate',
    // Knowledge
    'web.search',
    // Navigation (UI-only)
    'navigate',
  ],
  inputKinds: ['dashboard'],
  outputKinds: [],
  permissionMode: 'read_only',
  maxIterations: 30,
});

agentRegistry.register({
  type: 'dashboard-assistant',
  description: 'Dashboard + folder assistant — full dashboard/folder CRUD + Prometheus + web. No alert or user management.',
  allowedTools: [
    'dashboard.create', 'dashboard.list',
    'dashboard.add_panels', 'dashboard.remove_panels', 'dashboard.modify_panel',
    'dashboard.rearrange', 'dashboard.add_variable', 'dashboard.set_title',
    'folder.create', 'folder.list',
    'prometheus.query', 'prometheus.range_query', 'prometheus.labels', 'prometheus.label_values',
    'prometheus.series', 'prometheus.metadata', 'prometheus.metric_names', 'prometheus.validate',
    'web.search',
    'navigate',
  ],
  inputKinds: ['dashboard'],
  outputKinds: ['dashboard', 'panel', 'dashboard_variable'],
  permissionMode: 'artifact_mutation',
  maxIterations: 30,
});

agentRegistry.register({
  type: 'alert-advisor',
  description: 'Alert-rule advisor — full alert.* + Prometheus + folder + dashboard read. No dashboard mutation.',
  allowedTools: [
    'create_alert_rule', 'modify_alert_rule', 'delete_alert_rule',
    'alert_rule.list', 'alert_rule.history',
    'prometheus.query', 'prometheus.range_query', 'prometheus.labels', 'prometheus.label_values',
    'prometheus.series', 'prometheus.metadata', 'prometheus.metric_names', 'prometheus.validate',
    'folder.list',
    'dashboard.list',
    'web.search',
    'navigate',
  ],
  inputKinds: ['dashboard'],
  outputKinds: ['alert_rule'],
  permissionMode: 'artifact_mutation',
  maxIterations: 30,
});

agentRegistry.register({
  type: 'incident-responder',
  description: 'Investigation + incident response — investigation.* + alert read + Prometheus + dashboard/folder read.',
  allowedTools: [
    'investigation.create', 'investigation.list', 'investigation.add_section', 'investigation.complete',
    'alert_rule.list', 'alert_rule.history',
    'prometheus.query', 'prometheus.range_query', 'prometheus.labels', 'prometheus.label_values',
    'prometheus.series', 'prometheus.metadata', 'prometheus.metric_names', 'prometheus.validate',
    'dashboard.list',
    'folder.list',
    'web.search',
    'navigate',
  ],
  inputKinds: ['dashboard'],
  outputKinds: ['investigation_report'],
  permissionMode: 'artifact_mutation',
  maxIterations: 30,
});

agentRegistry.register({
  type: 'alert-rule-builder',
  description: 'Generates alert rules from natural language, using dashboard context and Prometheus metric discovery',
  allowedTools: ['create_alert_rule', 'prometheus.query', 'prometheus.labels', 'llm.complete'],
  inputKinds: ['dashboard', 'panel'],
  outputKinds: ['alert_rule'],
  permissionMode: 'propose_only',
});

agentRegistry.register({
  type: 'verification',
  description: 'Verifies generated artifacts (dashboards, investigation reports, alert rules) meet quality standards',
  allowedTools: ['verifier.run', 'prometheus.query', 'llm.complete'],
  inputKinds: ['dashboard', 'investigation_report', 'alert_rule'],
  outputKinds: [],
  permissionMode: 'read_only',
  canRunInBackground: true,
});
