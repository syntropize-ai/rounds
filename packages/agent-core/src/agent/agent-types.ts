export type AgentType =
  | 'orchestrator'
  | 'alert-rule-builder'
  | 'verification';

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
  // Source-agnostic metrics primitives (each requires `sourceId`)
  | 'metrics.query' | 'metrics.range_query' | 'metrics.labels' | 'metrics.label_values'
  | 'metrics.series' | 'metrics.metadata' | 'metrics.metric_names' | 'metrics.validate'
  // Source-agnostic logs primitives (each requires `sourceId`)
  | 'logs.query' | 'logs.labels' | 'logs.label_values'
  // Recent change events (deploys, config rollouts, incidents)
  | 'changes.list_recent'
  // Datasource discovery (always-allowed, no RBAC)
  | 'datasources.list'
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
