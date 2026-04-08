export type AgentType =
  | 'intent-router'
  | 'dashboard-builder'
  | 'dashboard-editor'
  | 'panel-explainer'
  | 'investigation-runner'
  | 'alert-rule-builder'
  | 'execution'
  | 'verification';

export type AgentToolName =
  | 'generate_dashboard' | 'add_panels' | 'investigate'
  | 'create_alert_rule' | 'modify_alert_rule' | 'delete_alert_rule' | 'modify_panel' | 'remove_panels'
  | 'rearrange' | 'add_variable' | 'set_title'
  | 'prometheus.query' | 'prometheus.labels'
  | 'web.search' | 'llm.complete'
  | 'adapter.validate' | 'adapter.dryRun' | 'adapter.execute'
  | 'verifier.run';

export type ArtifactKind =
  | 'dashboard' | 'panel' | 'dashboard_variable'
  | 'investigation_report' | 'evidence_panel'
  | 'alert_rule' | 'execution_plan' | 'execution_result';

export type AgentPermissionMode =
  | 'read_only' | 'artifact_mutation'
  | 'propose_only' | 'approval_required' | 'guarded_execution';
