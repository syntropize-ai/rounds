export type AgentType =
  | 'orchestrator'
  | 'alert-rule-builder'
  | 'verification';

export type AgentToolName =
  // Dashboard lifecycle
  | 'dashboard.create' | 'dashboard.list' | 'dashboard.clone'
  // Dashboard mutation primitives — model constructs panel configs directly
  | 'dashboard.add_panels' | 'dashboard.remove_panels' | 'dashboard.modify_panel'
  | 'dashboard.rearrange' | 'dashboard.add_variable' | 'dashboard.set_title'
  // Folder tools (Wave 7)
  | 'folder.create' | 'folder.list'
  // Investigation lifecycle
  | 'investigation.create' | 'investigation.list'
  | 'investigation.add_section'
  | 'investigation.complete'
  // Alert rule management — write is the unified create/update/delete tool
  | 'alert_rule.write'
  | 'alert_rule.list' | 'alert_rule.history'
  // Navigation
  | 'navigate'
  // Source-agnostic metrics primitives (each requires `sourceId`)
  | 'metrics.query' | 'metrics.range_query' | 'metrics.discover' | 'metrics.validate'
  // Source-agnostic logs primitives (each requires `sourceId`)
  | 'logs.query' | 'logs.labels' | 'logs.label_values'
  // Recent change events (deploys, config rollouts, incidents)
  | 'changes.list_recent'
  // Kubernetes / Ops integrations
  | 'ops.run_command'
  // Datasource discovery (always-allowed, no RBAC)
  | 'datasources.list' | 'datasources.suggest' | 'datasources.pin' | 'datasources.unpin'
  // Knowledge & utility
  | 'web.search' | 'llm.complete'
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
