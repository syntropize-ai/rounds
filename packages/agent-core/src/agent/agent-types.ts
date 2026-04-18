export type AgentType =
  | 'orchestrator'
  | 'alert-rule-builder'
  | 'verification'
  // Wave 7 specialized agents — tighter allowedTools ceilings.
  | 'readonly-analyst'
  | 'dashboard-assistant'
  | 'alert-advisor'
  | 'incident-responder';

export type AgentToolName =
  // Dashboard lifecycle
  | 'dashboard.create' | 'dashboard.list'
  // Dashboard mutation primitives — model constructs panel configs directly
  | 'dashboard.add_panels' | 'dashboard.remove_panels' | 'dashboard.modify_panel'
  | 'dashboard.rearrange' | 'dashboard.add_variable' | 'dashboard.set_title'
  // Folder tools (Wave 7)
  | 'folder.create' | 'folder.list'
  // Investigation lifecycle
  | 'investigation.create' | 'investigation.list'
  | 'investigation.add_section'
  | 'investigation.complete'
  // Alert rule management
  | 'create_alert_rule' | 'modify_alert_rule' | 'delete_alert_rule'
  | 'alert_rule.list' | 'alert_rule.history'
  // Navigation
  | 'navigate'
  // Prometheus primitives
  | 'prometheus.query' | 'prometheus.range_query' | 'prometheus.labels' | 'prometheus.label_values'
  | 'prometheus.series' | 'prometheus.metadata' | 'prometheus.metric_names' | 'prometheus.validate'
  // Knowledge & utility
  | 'web.search' | 'llm.complete'
  | 'verifier.run';

export type ArtifactKind =
  | 'dashboard' | 'panel' | 'dashboard_variable'
  | 'investigation_report' | 'evidence_panel'
  | 'alert_rule';

export type AgentPermissionMode =
  | 'read_only' | 'artifact_mutation'
  | 'propose_only' | 'approval_required' | 'guarded_execution';
