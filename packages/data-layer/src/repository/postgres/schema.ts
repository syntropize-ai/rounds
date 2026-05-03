import {
  pgTable,
  text,
  integer,
  boolean,
  jsonb,
  index,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

// Canonical Postgres Drizzle table definitions. Runtime DDL still lives in
// schema.sql; this file is the single TypeScript table-definition source used
// by createDbClient and Postgres repositories.

export const incidents = pgTable(
  'incidents',
  {
    id: text('id').primaryKey(),
    tenantId: text('tenant_id').notNull().default(''),
    title: text('title').notNull(),
    severity: text('severity').notNull(),
    status: text('status').notNull().default('open'),
    serviceIds: jsonb('service_ids').notNull().default([]),
    investigationIds: jsonb('investigation_ids').notNull().default([]),
    timeline: jsonb('timeline').notNull().default([]),
    assignee: text('assignee'),
    workspaceId: text('workspace_id'),
    orgId: text('org_id').notNull().default('org_main'),
    archived: boolean('archived').notNull().default(false),
    resolvedAt: text('resolved_at'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => [
    index('pg_repo_incidents_tenant_idx').on(t.tenantId),
    index('pg_repo_incidents_status_idx').on(t.status),
    index('pg_repo_incidents_org_idx').on(t.orgId),
  ],
);

export const feedItems = pgTable(
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
    hypothesisFeedback: jsonb('hypothesis_feedback'),
    actionFeedback: jsonb('action_feedback'),
    investigationId: text('investigation_id'),
    orgId: text('org_id').notNull().default('org_main'),
    followedUp: boolean('followed_up').notNull().default(false),
    createdAt: text('created_at').notNull(),
  },
  (t) => [
    index('pg_repo_feed_items_status_idx').on(t.status),
    index('pg_repo_feed_items_org_idx').on(t.orgId),
  ],
);

export const approvals = pgTable(
  'approvals',
  {
    id: text('id').primaryKey(),
    action: jsonb('action').notNull(),
    context: jsonb('context').notNull(),
    status: text('status').notNull().default('pending'),
    expiresAt: text('expires_at').notNull(),
    resolvedAt: text('resolved_at'),
    resolvedBy: text('resolved_by'),
    resolvedByRoles: jsonb('resolved_by_roles'),
    orgId: text('org_id').notNull().default('org_main'),
    createdAt: text('created_at').notNull(),
  },
  (t) => [
    index('pg_repo_approvals_status_idx').on(t.status),
    index('pg_repo_approvals_org_idx').on(t.orgId),
  ],
);

export const shareLinks = pgTable(
  'share_links',
  {
    token: text('token').primaryKey(),
    investigationId: text('investigation_id').notNull(),
    createdBy: text('created_by').notNull(),
    permission: text('permission').notNull().default('view_only'),
    expiresAt: text('expires_at'),
    createdAt: text('created_at').notNull(),
  },
  (t) => [
    uniqueIndex('pg_repo_share_links_token_idx').on(t.token),
    index('pg_repo_share_links_investigation_idx').on(t.investigationId),
  ],
);

export const contactPoints = pgTable('contact_points', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  integrations: jsonb('integrations').notNull(),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

export const notificationPolicyTree = pgTable('notification_policy_tree', {
  id: text('id').primaryKey().default('root'),
  tree: jsonb('tree').notNull(),
  updatedAt: text('updated_at').notNull(),
});

export const muteTimings = pgTable('mute_timings', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  timeIntervals: jsonb('time_intervals').notNull(),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

export const notificationDispatch = pgTable(
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

export const folders = pgTable(
  'folders',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    parentId: text('parent_id'),
    createdAt: text('created_at').notNull(),
  },
  (t) => [index('pg_repo_folders_parent_idx').on(t.parentId)],
);

export const assetVersions = pgTable(
  'asset_versions',
  {
    id: text('id').primaryKey(),
    assetType: text('asset_type').notNull(),
    assetId: text('asset_id').notNull(),
    version: integer('version').notNull(),
    snapshot: jsonb('snapshot').notNull(),
    diff: jsonb('diff'),
    editedBy: text('edited_by').notNull(),
    editSource: text('edit_source').notNull(),
    message: text('message'),
    createdAt: text('created_at').notNull(),
  },
  (t) => [
    index('pg_repo_asset_versions_asset_idx').on(t.assetType, t.assetId),
    index('pg_repo_asset_versions_version_idx').on(t.assetType, t.assetId, t.version),
  ],
);

export const cases = pgTable(
  'cases',
  {
    id: text('id').primaryKey(),
    tenantId: text('tenant_id').notNull().default(''),
    title: text('title').notNull(),
    symptoms: jsonb('symptoms').notNull().default([]),
    rootCause: text('root_cause').notNull(),
    resolution: text('resolution').notNull(),
    services: jsonb('services').notNull().default([]),
    tags: jsonb('tags').notNull().default([]),
    evidenceRefs: jsonb('evidence_refs').notNull().default([]),
    actions: jsonb('actions').notNull().default([]),
    outcome: text('outcome'),
    createdAt: text('created_at').notNull(),
  },
  (t) => [index('pg_repo_cases_tenant_idx').on(t.tenantId)],
);

export const postMortems = pgTable(
  'post_mortems',
  {
    id: text('id').primaryKey(),
    incidentId: text('incident_id').notNull(),
    summary: text('summary').notNull(),
    impact: text('impact').notNull(),
    timeline: jsonb('timeline').notNull(),
    rootCause: text('root_cause').notNull(),
    actionsTaken: jsonb('actions_taken').notNull(),
    lessonsLearned: jsonb('lessons_learned').notNull(),
    actionItems: jsonb('action_items').notNull(),
    generatedAt: text('generated_at').notNull(),
    generatedBy: text('generated_by').notNull().default('llm'),
  },
  (t) => [uniqueIndex('pg_repo_post_mortems_incident_idx').on(t.incidentId)],
);

export const investigationReports = pgTable(
  'investigation_reports',
  {
    id: text('id').primaryKey(),
    dashboardId: text('dashboard_id').notNull(),
    goal: text('goal').notNull(),
    summary: text('summary').notNull(),
    sections: jsonb('sections').notNull(),
    createdAt: text('created_at').notNull(),
  },
  (t) => [index('pg_repo_investigation_reports_dashboard_idx').on(t.dashboardId)],
);

export const chatSessions = pgTable(
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
    index('pg_repo_chat_sessions_org_idx').on(t.orgId),
    index('pg_repo_chat_sessions_owner_idx').on(t.orgId, t.ownerUserId),
  ],
);

export const chatSessionContexts = pgTable(
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
    index('pg_repo_chat_session_contexts_session_idx').on(t.sessionId),
    index('pg_repo_chat_session_contexts_owner_idx').on(t.orgId, t.ownerUserId),
    index('pg_repo_chat_session_contexts_resource_idx').on(
      t.orgId,
      t.resourceType,
      t.resourceId,
    ),
    uniqueIndex('pg_repo_chat_session_contexts_unique_idx').on(
      t.sessionId,
      t.resourceType,
      t.resourceId,
      t.relation,
    ),
  ],
);

export const chatMessages = pgTable(
  'chat_messages',
  {
    id: text('id').primaryKey(),
    sessionId: text('session_id').notNull(),
    role: text('role').notNull(),
    content: text('content').notNull(),
    actions: jsonb('actions'),
    timestamp: text('timestamp').notNull(),
  },
  (t) => [index('pg_repo_chat_messages_session_idx').on(t.sessionId)],
);

export const chatSessionEvents = pgTable(
  'chat_session_events',
  {
    id: text('id').primaryKey(),
    sessionId: text('session_id').notNull(),
    seq: integer('seq').notNull(),
    kind: text('kind').notNull(),
    payload: jsonb('payload').notNull(),
    timestamp: text('timestamp').notNull(),
  },
  (t) => [
    index('pg_repo_chat_session_events_session_idx').on(t.sessionId),
    index('pg_repo_chat_session_events_seq_idx').on(t.sessionId, t.seq),
  ],
);
