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
  type: 'intent-router',
  description: 'Classifies user intent and routes to the appropriate specialist agent',
  allowedTools: ['generate_dashboard', 'add_panels', 'investigate', 'create_alert_rule', 'modify_panel', 'remove_panels', 'rearrange', 'add_variable', 'set_title'],
  inputKinds: ['dashboard'],
  outputKinds: ['dashboard', 'panel', 'dashboard_variable', 'investigation_report', 'alert_rule'],
  permissionMode: 'artifact_mutation',
  maxIterations: 10,
});

agentRegistry.register({
  type: 'dashboard-builder',
  description: 'Generates complete dashboards from a natural-language prompt via research, discovery, and generation phases',
  allowedTools: ['generate_dashboard', 'prometheus.query', 'prometheus.labels', 'llm.complete'],
  inputKinds: [],
  outputKinds: ['dashboard', 'panel', 'dashboard_variable'],
  permissionMode: 'artifact_mutation',
});

agentRegistry.register({
  type: 'investigation-runner',
  description: 'Runs an observability investigation: plans queries, gathers evidence, and produces a structured report with evidence panels',
  allowedTools: ['investigate', 'prometheus.query', 'prometheus.labels', 'llm.complete'],
  inputKinds: ['dashboard', 'panel'],
  outputKinds: ['investigation_report', 'evidence_panel'],
  permissionMode: 'read_only',
  canRunInBackground: true,
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
  type: 'execution',
  description: 'Classifies evidence and recommends remediation actions using rules and LLM-based classification',
  allowedTools: ['adapter.validate', 'adapter.dryRun', 'adapter.execute', 'llm.complete'],
  inputKinds: ['investigation_report', 'evidence_panel'],
  outputKinds: ['execution_plan', 'execution_result'],
  permissionMode: 'guarded_execution',
});

agentRegistry.register({
  type: 'verification',
  description: 'Verifies generated artifacts (dashboards, investigation reports, alert rules) meet quality standards',
  allowedTools: ['verifier.run', 'prometheus.query', 'llm.complete'],
  inputKinds: ['dashboard', 'investigation_report', 'alert_rule'],
  outputKinds: ['execution_result'],
  permissionMode: 'read_only',
  canRunInBackground: true,
});
