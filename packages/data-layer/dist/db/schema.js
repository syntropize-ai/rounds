import { pgTable, text, timestamp, jsonb, index, uniqueIndex } from 'drizzle-orm/pg-core';
// — investigations
export const investigations = pgTable('investigations', {
  id: text('id').primaryKey(),
  tenantId: text('tenant_id').notNull(),
  sessionId: text('session_id'),
  userId: text('user_id'),
  intent: text('intent').notNull(),
  structuredIntent: jsonb('structured_intent'),
  plan: jsonb('plan'),
  status: text('status').notNull().default('pending'),
  hypotheses: jsonb('hypotheses').notNull().default([]),
  evidence: jsonb('evidence').notNull().default([]),
  symptoms: jsonb('symptoms').notNull().default([]),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  archivedAt: timestamp('archived_at', { withTimezone: true }),
}, (t) => [
  index('investigations_tenant_id_idx').on(t.tenantId),
  index('investigations_session_id_idx').on(t.sessionId),
  index('investigations_status_idx').on(t.status),
  index('investigations_created_at_idx').on(t.createdAt),
]);
// — incidents
export const incidents = pgTable('incidents', {
  id: text('id').primaryKey(),
  tenantId: text('tenant_id').notNull(),
  title: text('title').notNull(),
  severity: text('severity').notNull(),
  status: text('status').notNull().default('open'),
  services: jsonb('services').notNull().default([]),
  assignee: text('assignee'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  archivedAt: timestamp('archived_at', { withTimezone: true }),
}, (t) => [
  index('incidents_tenant_id_idx').on(t.tenantId),
  index('incidents_status_idx').on(t.status),
  index('incidents_severity_idx').on(t.severity),
  index('incidents_created_at_idx').on(t.createdAt),
]);
// — incident_timeline
export const incidentTimeline = pgTable('incident_timeline', {
  id: text('id').primaryKey(),
  incidentId: text('incident_id').notNull().references(() => incidents.id, { onDelete: 'cascade' }),
  type: text('type').notNull(),
  description: text('description').notNull(),
  actorType: text('actor_type'),
  actorId: text('actor_id'),
  referenceId: text('reference_id'),
  metadata: jsonb('metadata'),
  timestamp: timestamp('timestamp', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index('incident_timeline_incident_id_idx').on(t.incidentId),
  index('incident_timeline_type_idx').on(t.type),
  index('incident_timeline_timestamp_idx').on(t.timestamp),
]);
// — feed_events
export const feedEvents = pgTable('feed_events', {
  id: text('id').primaryKey(),
  tenantId: text('tenant_id').notNull(),
  type: text('type').notNull(),
  title: text('title').notNull(),
  summary: text('summary'),
  severity: text('severity'),
  metadata: jsonb('metadata'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index('feed_events_tenant_id_idx').on(t.tenantId),
  index('feed_events_type_idx').on(t.type),
  index('feed_events_created_at_idx').on(t.createdAt),
]);
// — cases
export const cases = pgTable('cases', {
  id: text('id').primaryKey(),
  tenantId: text('tenant_id').notNull(),
  title: text('title').notNull(),
  symptom: text('symptom').notNull().default(''),
  rootCause: text('root_cause').notNull(),
  resolution: text('resolution').notNull(),
  services: jsonb('services').notNull().default([]),
  tags: jsonb('tags').notNull().default([]),
  evidenceRefs: jsonb('evidence_refs').notNull().default([]),
  actions: jsonb('actions').notNull().default([]),
  outcomes: jsonb('outcomes').notNull().default([]),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index('cases_tenant_id_idx').on(t.tenantId),
  index('cases_created_at_idx').on(t.createdAt),
]);
// — approvals
export const approvals = pgTable('approvals', {
  id: text('id').primaryKey(),
  tenantId: text('tenant_id').notNull(),
  actionType: text('action_type').notNull(),
  requestedBy: text('requested_by').notNull(),
  resolvedBy: text('resolved_by'),
  status: text('status').notNull().default('pending'),
  params: jsonb('params').notNull().default({}),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  resolvedAt: timestamp('resolved_at', { withTimezone: true }),
}, (t) => [
  index('approvals_tenant_id_idx').on(t.tenantId),
  index('approvals_status_idx').on(t.status),
  index('approvals_created_at_idx').on(t.createdAt),
]);
// — sessions
export const sessions = pgTable('sessions', {
  id: text('id').primaryKey(),
  tenantId: text('tenant_id').notNull(),
  userId: text('user_id').notNull(),
  messages: jsonb('messages').notNull().default([]),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index('sessions_tenant_id_idx').on(t.tenantId),
  index('sessions_user_id_idx').on(t.userId),
  index('sessions_created_at_idx').on(t.createdAt),
]);
// — share_links
export const shareLinks = pgTable('share_links', {
  id: text('id').primaryKey(),
  investigationId: text('investigation_id').notNull().references(() => investigations.id, {
    onDelete: 'cascade',
  }),
  token: text('token').notNull(),
  permission: text('permission').notNull().default('view'),
  createdBy: text('created_by').notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex('share_links_token_idx').on(t.token),
  index('share_links_investigation_id_idx').on(t.investigationId),
  index('share_links_expires_at_idx').on(t.expiresAt),
]);
// — post_mortems
export const postMortems = pgTable('post_mortems', {
  id: text('id').primaryKey(),
  incidentId: text('incident_id').notNull().references(() => incidents.id, { onDelete: 'cascade' }),
  report: jsonb('report').notNull(),
  generatedBy: text('generated_by').notNull().default('llm'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index('post_mortems_incident_id_idx').on(t.incidentId),
  index('post_mortems_created_at_idx').on(t.createdAt),
]);
//# sourceMappingURL=schema.js.map
