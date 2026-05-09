export type AgentType =
  | 'orchestrator'
  | 'alert-rule-builder'
  | 'verification';

export type AgentToolName =
  // Dashboard lifecycle
  | 'dashboard_create' | 'dashboard_list' | 'dashboard_clone'
  // Dashboard mutation primitives — model constructs panel configs directly
  | 'dashboard_add_panels' | 'dashboard_remove_panels' | 'dashboard_modify_panel'
  | 'dashboard_rearrange' | 'dashboard_add_variable' | 'dashboard_set_title'
  // Folder tools (Wave 7)
  | 'folder_create' | 'folder_list'
  // Investigation lifecycle
  | 'investigation_create' | 'investigation_list'
  | 'investigation_add_section'
  | 'investigation_complete'
  // Alert rule management — write is the unified create/update/delete tool
  | 'alert_rule_write'
  | 'alert_rule_list' | 'alert_rule_history'
  // Navigation
  | 'navigate'
  // Source-agnostic metrics primitives (each requires `sourceId`)
  | 'metrics_query' | 'metrics_range_query' | 'metrics_discover' | 'metrics_validate'
  // Source-agnostic logs primitives (each requires `sourceId`)
  | 'logs_query' | 'logs_labels' | 'logs_label_values'
  // Recent change events (deploys, config rollouts, incidents)
  | 'changes_list_recent'
  // Kubernetes / Ops integrations
  | 'ops_run_command'
  // Datasource discovery (always-allowed, no RBAC)
  | 'datasources_list' | 'datasources_suggest' | 'datasources_pin' | 'datasources_unpin'
  // AI-first configuration (Task 07) — datasource / connector / low-risk org settings
  | 'datasource_configure' | 'ops_connector_configure' | 'system_setting_configure'
  // Knowledge & utility
  | 'web_search' | 'llm.complete'
  | 'verifier.run'
  // Lazy tool loading (fetches deferred-tool schemas on demand)
  | 'tool_search';

export type ArtifactKind =
  | 'dashboard' | 'panel' | 'dashboard_variable'
  | 'investigation_report' | 'evidence_panel'
  | 'alert_rule';

export type AgentPermissionMode =
  | 'read_only' | 'artifact_mutation'
  | 'propose_only' | 'approval_required' | 'guarded_execution';
