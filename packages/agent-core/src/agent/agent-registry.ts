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
    'dashboard.create',
    'dashboard.add_panels', 'dashboard.remove_panels', 'dashboard.modify_panel',
    'dashboard.rearrange', 'dashboard.add_variable', 'dashboard.set_title',
    // Investigation lifecycle
    'investigation.create',
    // Prometheus primitives
    'prometheus.query', 'prometheus.range_query', 'prometheus.labels', 'prometheus.label_values',
    'prometheus.series', 'prometheus.metadata', 'prometheus.metric_names', 'prometheus.validate',
    // Knowledge
    'web.search',
    // Alert rules
    'create_alert_rule', 'modify_alert_rule', 'delete_alert_rule',
  ],
  inputKinds: ['dashboard'],
  outputKinds: ['dashboard', 'panel', 'dashboard_variable', 'investigation_report', 'alert_rule'],
  permissionMode: 'artifact_mutation',
  maxIterations: 15,
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
