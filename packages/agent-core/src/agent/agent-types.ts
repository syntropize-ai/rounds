export type AgentType =
  | 'orchestrator'
  | 'background_orchestrator'
  | 'verification';

export type AgentToolName =
  // Dashboard lifecycle
  | 'dashboard_create' | 'dashboard_list' | 'dashboard_clone'
  // Dashboard mutation primitives — model constructs panel configs directly
  | 'dashboard_add_panels' | 'dashboard_remove_panels' | 'dashboard_modify_panel'
  | 'dashboard_rearrange' | 'dashboard_add_variable' | 'dashboard_set_title'
  // Dashboard lint — pre-save validation via pluggable rule engine
  | 'dashboard_lint'
  // Folder tools (Wave 7)
  | 'folder_create' | 'folder_list'
  // Investigation lifecycle
  | 'investigation_create' | 'investigation_list'
  | 'investigation_add_text' | 'investigation_add_evidence'
  | 'investigation_complete'
  // Alert rule management — write is the unified create/update/delete tool
  | 'alert_rule_write'
  | 'alert_rule_list' | 'alert_rule_history'
  // Navigation
  | 'navigate'
  // Source-agnostic metrics primitives (each requires `sourceId`)
  | 'metrics_query' | 'metrics_range_query' | 'metrics_discover' | 'metrics_validate'
  // Narrow per-shape metric discovery primitives (Read/Grep/Glob style)
  | 'metrics_list_names' | 'metrics_get_labels' | 'metrics_get_label_values'
  | 'metrics_get_cardinality' | 'metrics_sample_series' | 'metrics_find_related'
  // Inline chart bubble in chat (uses shared chart-summary helper)
  | 'metric_explore'
  // Panel-spec preview — server-side renders + validates one panel before save
  | 'panel_preview'
  // Source-agnostic logs primitives (each requires `sourceId`)
  | 'logs_query' | 'logs_labels' | 'logs_label_values'
  // Recent change events (deploys, config rollouts, incidents)
  | 'changes_list_recent'
  // Kubernetes / Ops integrations
  | 'ops_run_command'
  | 'ops_cluster_shell'
  // GitHub VCS read tools (configured via Settings → Connectors → GitHub)
  | 'github_list_repos' | 'github_list_prs' | 'github_get_pr' | 'github_get_diff'
  // Remediation plans (proposal-only; PlanExecutorService runs approved steps)
  | 'remediation_plan_create' | 'remediation_plan_create_rescue'
  // Connector discovery (always-allowed, no RBAC)
  | 'connectors_list' | 'connectors_suggest' | 'connectors_pin' | 'connectors_unpin'
  // Connector-model setup and allowlisted org settings
  | 'connector_list' | 'connector_template_list' | 'connector_detect'
  | 'connector_propose' | 'connector_apply' | 'connector_test'
  | 'setting_get' | 'setting_set'
  // Knowledge base (hybrid lexical + semantic search over saved/distilled/bundled patterns)
  | 'kb_search' | 'kb_get' | 'kb_recommend'
  // Knowledge & utility
  | 'web_search' | 'llm.complete'
  | 'verifier.run'
  // Lazy tool loading (fetches deferred-tool schemas on demand)
  | 'tool_search'
  // Observation pager handled inside ReActLoop
  | 'read_observation'
  // On-demand task-context module loading (splits the system prompt)
  | 'load_task_context'
  // Clarifying question — terminal tool handled inside ReActLoop
  | 'ask_user';

export type ArtifactKind =
  | 'dashboard' | 'panel' | 'dashboard_variable'
  | 'investigation_report' | 'evidence_panel'
  | 'alert_rule';

export type AgentPermissionMode =
  | 'read_only' | 'artifact_mutation'
  | 'propose_only' | 'approval_required' | 'guarded_execution';

/**
 * Result shape for every `github_*` agent tool. We never throw across the
 * runner boundary — the runner surfaces auth failures, rate limits, 404s,
 * and policy denials as polite observation strings so the model can read
 * them and tell the user. `data` is present on success and is a
 * tool-specific structured payload (array | object | string for diffs).
 */
export interface GithubToolResult {
  observation: string;
  data?: unknown;
  truncated?: boolean;
}

/**
 * Agent-facing GitHub VCS surface. The concrete implementation lives in
 * api-gateway (`services/github-tool-runner.ts`) — agent-core only depends
 * on this interface so the package stays decoupled from express / data-layer.
 */
export interface GithubToolRunner {
  listRepos(args: { connectorId?: string; identity: import('@agentic-obs/common').Identity }): Promise<GithubToolResult>;
  listPrs(args: {
    connectorId?: string;
    owner: string;
    repo: string;
    state?: 'open' | 'closed' | 'all';
    limit?: number;
    identity: import('@agentic-obs/common').Identity;
  }): Promise<GithubToolResult>;
  getPr(args: {
    connectorId?: string;
    owner: string;
    repo: string;
    number: number;
    identity: import('@agentic-obs/common').Identity;
  }): Promise<GithubToolResult>;
  getDiff(args: {
    connectorId?: string;
    owner: string;
    repo: string;
    number: number;
    identity: import('@agentic-obs/common').Identity;
  }): Promise<GithubToolResult>;
}
