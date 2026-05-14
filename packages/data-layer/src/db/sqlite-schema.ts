import {
  sqliteTable,
  text,
  integer,
  index,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';

// — investigations

export const investigations = sqliteTable(
  'investigations',
  {
    id: text('id').primaryKey(),
    tenantId: text('tenant_id').notNull().default(''),
    sessionId: text('session_id'),
    userId: text('user_id'),
    intent: text('intent').notNull(),
    structuredIntent: text('structured_intent', { mode: 'json' }),
    plan: text('plan', { mode: 'json' }),
    status: text('status').notNull().default('pending'),
    hypotheses: text('hypotheses', { mode: 'json' }).notNull().default('[]'),
    actions: text('actions', { mode: 'json' }).notNull().default('[]'),
    evidence: text('evidence', { mode: 'json' }).notNull().default('[]'),
    symptoms: text('symptoms', { mode: 'json' }).notNull().default('[]'),
    workspaceId: text('workspace_id'),
    // Multi-org tenancy (T4.4) — every resource row is scoped by org_id.
    // Default 'org_main' mirrors migration 015_alter_resources.sql.
    orgId: text('org_id').notNull().default('org_main'),
    archived: integer('archived', { mode: 'boolean' }).notNull().default(false),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => [
    index('investigations_tenant_idx').on(t.tenantId),
    index('investigations_session_idx').on(t.sessionId),
    index('investigations_status_idx').on(t.status),
    index('investigations_workspace_idx').on(t.workspaceId),
    index('investigations_org_idx').on(t.orgId),
    index('investigations_created_at_idx').on(t.createdAt),
  ],
);

// — investigation follow-ups

export const investigationFollowUps = sqliteTable(
  'investigation_follow_ups',
  {
    id: text('id').primaryKey(),
    investigationId: text('investigation_id').notNull().references(() => investigations.id, { onDelete: 'cascade' }),
    question: text('question').notNull(),
    createdAt: text('created_at').notNull(),
  },
  (t) => [
    index('follow_ups_investigation_idx').on(t.investigationId),
  ],
);

// — investigation feedback

export const investigationFeedback = sqliteTable(
  'investigation_feedback',
  {
    id: text('id').primaryKey(),
    investigationId: text('investigation_id').notNull().references(() => investigations.id, { onDelete: 'cascade' }),
    helpful: integer('helpful', { mode: 'boolean' }).notNull(),
    comment: text('comment'),
    rootCauseVerdict: text('root_cause_verdict'),
    hypothesisFeedbacks: text('hypothesis_feedbacks', { mode: 'json' }),
    actionFeedbacks: text('action_feedbacks', { mode: 'json' }),
    createdAt: text('created_at').notNull(),
  },
  (t) => [
    index('feedback_investigation_idx').on(t.investigationId),
  ],
);

// — investigation conclusions

export const investigationConclusions = sqliteTable(
  'investigation_conclusions',
  {
    investigationId: text('investigation_id').primaryKey().references(() => investigations.id, { onDelete: 'cascade' }),
    conclusion: text('conclusion', { mode: 'json' }).notNull(),
  },
);

// — incidents

export const incidents = sqliteTable(
  'incidents',
  {
    id: text('id').primaryKey(),
    tenantId: text('tenant_id').notNull().default(''),
    title: text('title').notNull(),
    severity: text('severity').notNull(),
    status: text('status').notNull().default('open'),
    serviceIds: text('service_ids', { mode: 'json' }).notNull().default('[]'),
    investigationIds: text('investigation_ids', { mode: 'json' }).notNull().default('[]'),
    timeline: text('timeline', { mode: 'json' }).notNull().default('[]'),
    assignee: text('assignee'),
    workspaceId: text('workspace_id'),
    orgId: text('org_id').notNull().default('org_main'),
    archived: integer('archived', { mode: 'boolean' }).notNull().default(false),
    resolvedAt: text('resolved_at'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => [
    index('incidents_tenant_idx').on(t.tenantId),
    index('incidents_status_idx').on(t.status),
    index('incidents_severity_idx').on(t.severity),
    index('incidents_workspace_idx').on(t.workspaceId),
    index('incidents_org_idx').on(t.orgId),
    index('incidents_created_at_idx').on(t.createdAt),
  ],
);

// — feed items

export const feedItems = sqliteTable(
  'feed_items',
  {
    id: text('id').primaryKey(),
    tenantId: text('tenant_id').notNull().default(''),
    type: text('type').notNull(),
    title: text('title').notNull(),
    summary: text('summary').notNull(),
    severity: text('severity').notNull(),
    status: text('status').notNull().default('unread'),
    feedback: text('feedback'),
    feedbackComment: text('feedback_comment'),
    hypothesisFeedback: text('hypothesis_feedback', { mode: 'json' }),
    actionFeedback: text('action_feedback', { mode: 'json' }),
    investigationId: text('investigation_id'),
    orgId: text('org_id').notNull().default('org_main'),
    followedUp: integer('followed_up', { mode: 'boolean' }).notNull().default(false),
    createdAt: text('created_at').notNull(),
  },
  (t) => [
    index('feed_items_tenant_idx').on(t.tenantId),
    index('feed_items_type_idx').on(t.type),
    index('feed_items_severity_idx').on(t.severity),
    index('feed_items_status_idx').on(t.status),
    index('feed_items_org_idx').on(t.orgId),
    index('feed_items_created_at_idx').on(t.createdAt),
  ],
);

// — approvals

export const approvals = sqliteTable(
  'approvals',
  {
    id: text('id').primaryKey(),
    action: text('action', { mode: 'json' }).notNull(),
    context: text('context', { mode: 'json' }).notNull(),
    status: text('status').notNull().default('pending'),
    expiresAt: text('expires_at').notNull(),
    resolvedAt: text('resolved_at'),
    resolvedBy: text('resolved_by'),
    resolvedByRoles: text('resolved_by_roles', { mode: 'json' }),
    orgId: text('org_id').notNull().default('org_main'),
    opsConnectorId: text('ops_connector_id'),
    targetNamespace: text('target_namespace'),
    requesterTeamId: text('requester_team_id'),
    createdAt: text('created_at').notNull(),
  },
  (t) => [
    index('approvals_status_idx').on(t.status),
    index('approvals_org_idx').on(t.orgId),
    index('approvals_created_at_idx').on(t.createdAt),
    index('ix_approvals_connector').on(t.opsConnectorId),
    index('ix_approvals_namespace').on(t.opsConnectorId, t.targetNamespace),
    index('ix_approvals_team').on(t.requesterTeamId),
  ],
);

// — share links

export const shareLinks = sqliteTable(
  'share_links',
  {
    token: text('token').primaryKey(),
    investigationId: text('investigation_id').notNull().references(() => investigations.id, { onDelete: 'cascade' }),
    createdBy: text('created_by').notNull(),
    permission: text('permission').notNull().default('view_only'),
    expiresAt: text('expires_at'),
    createdAt: text('created_at').notNull(),
  },
  (t) => [
    uniqueIndex('share_links_token_idx').on(t.token),
    index('share_links_investigation_idx').on(t.investigationId),
  ],
);

// — dashboards

export const dashboards = sqliteTable(
  'dashboards',
  {
    id: text('id').primaryKey(),
    type: text('type').notNull().default('dashboard'),
    title: text('title').notNull(),
    description: text('description').notNull(),
    prompt: text('prompt').notNull(),
    userId: text('user_id').notNull(),
    status: text('status').notNull().default('generating'),
    panels: text('panels', { mode: 'json' }).notNull().default('[]'),
    variables: text('variables', { mode: 'json' }).notNull().default('[]'),
    refreshIntervalSec: integer('refresh_interval_sec').notNull().default(30),
    datasourceIds: text('datasource_ids', { mode: 'json' }).notNull().default('[]'),
    useExistingMetrics: integer('use_existing_metrics', { mode: 'boolean' }).notNull().default(true),
    folder: text('folder'),
    workspaceId: text('workspace_id'),
    orgId: text('org_id').notNull().default('org_main'),
    version: integer('version'),
    publishStatus: text('publish_status'),
    error: text('error'),
    // Provisioning marker — see packages/common/src/resources/writable-gate.ts.
    source: text('source').notNull().default('manual'),
    provenance: text('provenance', { mode: 'json' }),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => [
    index('dashboards_user_idx').on(t.userId),
    index('dashboards_workspace_idx').on(t.workspaceId),
    index('dashboards_org_idx').on(t.orgId),
    index('dashboards_status_idx').on(t.status),
    index('dashboards_created_at_idx').on(t.createdAt),
  ],
);

// — alert rules

export const alertRules = sqliteTable(
  'alert_rules',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    description: text('description').notNull(),
    originalPrompt: text('original_prompt'),
    condition: text('condition', { mode: 'json' }).notNull(),
    evaluationIntervalSec: integer('evaluation_interval_sec').notNull().default(60),
    severity: text('severity').notNull(),
    labels: text('labels', { mode: 'json' }),
    state: text('state').notNull().default('normal'),
    stateChangedAt: text('state_changed_at').notNull(),
    pendingSince: text('pending_since'),
    notificationPolicyId: text('notification_policy_id'),
    investigationId: text('investigation_id'),
    workspaceId: text('workspace_id'),
    orgId: text('org_id').notNull().default('org_main'),
    createdBy: text('created_by').notNull(),
    lastEvaluatedAt: text('last_evaluated_at'),
    lastFiredAt: text('last_fired_at'),
    fireCount: integer('fire_count').notNull().default(0),
    // Provisioning marker — see packages/common/src/resources/writable-gate.ts.
    source: text('source').notNull().default('manual'),
    provenance: text('provenance', { mode: 'json' }),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => [
    index('alert_rules_state_idx').on(t.state),
    index('alert_rules_severity_idx').on(t.severity),
    index('alert_rules_workspace_idx').on(t.workspaceId),
    index('alert_rules_org_idx').on(t.orgId),
    index('alert_rules_updated_at_idx').on(t.updatedAt),
  ],
);

// — alert history

export const alertHistory = sqliteTable(
  'alert_history',
  {
    id: text('id').primaryKey(),
    ruleId: text('rule_id').notNull().references(() => alertRules.id, { onDelete: 'cascade' }),
    ruleName: text('rule_name').notNull(),
    fromState: text('from_state').notNull(),
    toState: text('to_state').notNull(),
    value: integer('value').notNull().default(0),
    threshold: integer('threshold').notNull().default(0),
    timestamp: text('timestamp').notNull(),
    labels: text('labels', { mode: 'json' }).notNull().default('{}'),
  },
  (t) => [
    index('alert_history_rule_idx').on(t.ruleId),
    index('alert_history_timestamp_idx').on(t.timestamp),
  ],
);

// — alert silences

export const alertSilences = sqliteTable(
  'alert_silences',
  {
    id: text('id').primaryKey(),
    matchers: text('matchers', { mode: 'json' }).notNull(),
    startsAt: text('starts_at').notNull(),
    endsAt: text('ends_at').notNull(),
    comment: text('comment').notNull(),
    createdBy: text('created_by').notNull(),
    createdAt: text('created_at').notNull(),
  },
  (t) => [
    index('alert_silences_ends_at_idx').on(t.endsAt),
  ],
);

// — notification policies (flat, from AlertRuleStore)

export const notificationPolicies = sqliteTable(
  'notification_policies',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    matchers: text('matchers', { mode: 'json' }).notNull(),
    channels: text('channels', { mode: 'json' }).notNull(),
    groupBy: text('group_by', { mode: 'json' }),
    groupWaitSec: integer('group_wait_sec'),
    groupIntervalSec: integer('group_interval_sec'),
    repeatIntervalSec: integer('repeat_interval_sec'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
);

// — contact points

export const contactPoints = sqliteTable(
  'contact_points',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    integrations: text('integrations', { mode: 'json' }).notNull(),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
);

// — notification policy tree (stored as single JSON row)

export const notificationPolicyTree = sqliteTable(
  'notification_policy_tree',
  {
    id: text('id').primaryKey().default('root'),
    tree: text('tree', { mode: 'json' }).notNull(),
    updatedAt: text('updated_at').notNull(),
  },
);

// — mute timings

export const muteTimings = sqliteTable(
  'mute_timings',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    timeIntervals: text('time_intervals', { mode: 'json' }).notNull(),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
);

// — notification dispatch tracking (T3): one row per
// (fingerprint, contactPointId, groupKey) used to gate group / repeat windows.

export const notificationDispatch = sqliteTable(
  'notification_dispatch',
  {
    id: text('id').primaryKey(),
    orgId: text('org_id').notNull(),
    fingerprint: text('fingerprint').notNull(),
    contactPointId: text('contact_point_id').notNull(),
    groupKey: text('group_key').notNull(),
    lastSentAt: text('last_sent_at').notNull(),
    sentCount: integer('sent_count').notNull(),
  },
  (t) => [
    uniqueIndex('ux_notification_dispatch_key').on(t.fingerprint, t.contactPointId, t.groupKey),
    index('idx_notification_dispatch_lookup').on(t.orgId, t.fingerprint, t.contactPointId),
  ],
);

// — workspaces

export const workspaces = sqliteTable(
  'workspaces',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    slug: text('slug').notNull(),
    ownerId: text('owner_id').notNull(),
    members: text('members', { mode: 'json' }).notNull().default('[]'),
    settings: text('settings', { mode: 'json' }).notNull().default('{}'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => [
    uniqueIndex('workspaces_slug_idx').on(t.slug),
    index('workspaces_owner_idx').on(t.ownerId),
  ],
);

// — folders

export const folders = sqliteTable(
  'folders',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    parentId: text('parent_id'),
    createdAt: text('created_at').notNull(),
  },
  (t) => [
    index('folders_parent_idx').on(t.parentId),
  ],
);

// — asset versions

export const assetVersions = sqliteTable(
  'asset_versions',
  {
    id: text('id').primaryKey(),
    assetType: text('asset_type').notNull(),
    assetId: text('asset_id').notNull(),
    version: integer('version').notNull(),
    snapshot: text('snapshot', { mode: 'json' }).notNull(),
    diff: text('diff', { mode: 'json' }),
    editedBy: text('edited_by').notNull(),
    editSource: text('edit_source').notNull(),
    message: text('message'),
    createdAt: text('created_at').notNull(),
  },
  (t) => [
    index('asset_versions_asset_idx').on(t.assetType, t.assetId),
    index('asset_versions_version_idx').on(t.assetType, t.assetId, t.version),
  ],
);

// — cases

export const cases = sqliteTable(
  'cases',
  {
    id: text('id').primaryKey(),
    tenantId: text('tenant_id').notNull().default(''),
    title: text('title').notNull(),
    symptoms: text('symptoms', { mode: 'json' }).notNull().default('[]'),
    rootCause: text('root_cause').notNull(),
    resolution: text('resolution').notNull(),
    services: text('services', { mode: 'json' }).notNull().default('[]'),
    tags: text('tags', { mode: 'json' }).notNull().default('[]'),
    evidenceRefs: text('evidence_refs', { mode: 'json' }).notNull().default('[]'),
    actions: text('actions', { mode: 'json' }).notNull().default('[]'),
    outcome: text('outcome'),
    createdAt: text('created_at').notNull(),
  },
  (t) => [
    index('cases_tenant_idx').on(t.tenantId),
    index('cases_created_at_idx').on(t.createdAt),
  ],
);

// — post-mortem reports

export const postMortems = sqliteTable(
  'post_mortems',
  {
    id: text('id').primaryKey(),
    incidentId: text('incident_id').notNull().references(() => incidents.id, { onDelete: 'cascade' }),
    summary: text('summary').notNull(),
    impact: text('impact').notNull(),
    timeline: text('timeline', { mode: 'json' }).notNull(),
    rootCause: text('root_cause').notNull(),
    actionsTaken: text('actions_taken', { mode: 'json' }).notNull(),
    lessonsLearned: text('lessons_learned', { mode: 'json' }).notNull(),
    actionItems: text('action_items', { mode: 'json' }).notNull(),
    generatedAt: text('generated_at').notNull(),
    generatedBy: text('generated_by').notNull().default('llm'),
  },
  (t) => [
    uniqueIndex('post_mortems_incident_idx').on(t.incidentId),
  ],
);

// — saved investigation reports

export const investigationReports = sqliteTable(
  'investigation_reports',
  {
    id: text('id').primaryKey(),
    dashboardId: text('dashboard_id').notNull(), // Stores investigationId despite the column name (legacy naming)
    goal: text('goal').notNull(),
    summary: text('summary').notNull(),
    sections: text('sections', { mode: 'json' }).notNull(),
    createdAt: text('created_at').notNull(),
    // Optional provenance JSON (model, runId, toolCalls, cost, latency, citations).
    // Nullable so rows pre-dating Task 10 keep working.
    provenance: text('provenance', { mode: 'json' }),
  },
  (t) => [
    index('investigation_reports_dashboard_idx').on(t.dashboardId),
  ],
);

// — chat sessions

export const chatSessions = sqliteTable(
  'chat_sessions',
  {
    id: text('id').primaryKey(),
    title: text('title').notNull().default(''),
    contextSummary: text('context_summary'),
    orgId: text('org_id').notNull().default('org_main'),
    ownerUserId: text('owner_user_id'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => [
    index('chat_sessions_updated_at_idx').on(t.updatedAt),
    index('chat_sessions_org_idx').on(t.orgId),
    index('chat_sessions_owner_idx').on(t.orgId, t.ownerUserId),
  ],
);

export const chatSessionContexts = sqliteTable(
  'chat_session_contexts',
  {
    id: text('id').primaryKey(),
    sessionId: text('session_id').notNull(),
    orgId: text('org_id').notNull().default('org_main'),
    ownerUserId: text('owner_user_id').notNull(),
    resourceType: text('resource_type').notNull(),
    resourceId: text('resource_id').notNull(),
    relation: text('relation').notNull(),
    createdAt: text('created_at').notNull(),
  },
  (t) => [
    index('chat_session_contexts_session_idx').on(t.sessionId),
    index('chat_session_contexts_owner_idx').on(t.orgId, t.ownerUserId),
    index('chat_session_contexts_resource_idx').on(t.orgId, t.resourceType, t.resourceId),
    uniqueIndex('chat_session_contexts_unique_idx').on(
      t.sessionId,
      t.resourceType,
      t.resourceId,
      t.relation,
    ),
  ],
);

// — chat messages (session-scoped, independent of dashboards)

export const chatMessages = sqliteTable(
  'chat_messages',
  {
    id: text('id').primaryKey(),
    sessionId: text('session_id').notNull(),
    role: text('role').notNull(),
    content: text('content').notNull(),
    actions: text('actions', { mode: 'json' }),
    timestamp: text('timestamp').notNull(),
  },
  (t) => [
    index('chat_messages_session_idx').on(t.sessionId),
    index('chat_messages_timestamp_idx').on(t.timestamp),
  ],
);

// — chat session events (SSE step trace: thinking, tool_call, tool_result,
//   panel_added, etc.). Persisted so the chat panel can replay the full
//   conversation (messages + agent activity) after a page refresh.

export const chatSessionEvents = sqliteTable(
  'chat_session_events',
  {
    id: text('id').primaryKey(),
    sessionId: text('session_id').notNull(),
    seq: integer('seq').notNull(),
    kind: text('kind').notNull(),
    payload: text('payload', { mode: 'json' }).notNull(),
    timestamp: text('timestamp').notNull(),
  },
  (t) => [
    index('chat_session_events_session_idx').on(t.sessionId),
    index('chat_session_events_seq_idx').on(t.sessionId, t.seq),
  ],
);
