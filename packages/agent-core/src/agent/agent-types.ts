export type AgentType =
  | 'orchestrator'
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
  // Inline chart bubble in chat (uses shared chart-summary helper)
  | 'metric_explore'
  // Source-agnostic logs primitives (each requires `sourceId`)
  | 'logs_query' | 'logs_labels' | 'logs_label_values'
  // Recent change events (deploys, config rollouts, incidents)
  | 'changes_list_recent'
  // Kubernetes / Ops integrations
  | 'ops_run_command'
  // Remediation plans (proposal-only; PlanExecutorService runs approved steps)
  | 'remediation_plan_create' | 'remediation_plan_create_rescue'
  // Connector discovery (always-allowed, no RBAC)
  | 'connectors_list' | 'connectors_suggest' | 'connectors_pin' | 'connectors_unpin'
  // Connector-model setup and allowlisted org settings
  | 'connector_list' | 'connector_template_list' | 'connector_detect'
  | 'connector_propose' | 'connector_apply' | 'connector_test'
  | 'setting_get' | 'setting_set'
  // Knowledge & utility
  | 'web_search' | 'llm.complete'
  | 'verifier.run'
  // Lazy tool loading (fetches deferred-tool schemas on demand)
  | 'tool_search'
  // Clarifying question — terminal tool handled inside ReActLoop
  | 'ask_user';

export type ArtifactKind =
  | 'dashboard' | 'panel' | 'dashboard_variable'
  | 'investigation_report' | 'evidence_panel'
  | 'alert_rule';

export type AgentPermissionMode =
  | 'read_only' | 'artifact_mutation'
  | 'propose_only' | 'approval_required' | 'guarded_execution';
