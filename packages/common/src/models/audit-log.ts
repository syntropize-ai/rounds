/**
 * Grafana ref: Grafana Enterprise pkg/services/auditlog/ (shape alignment only).
 * See docs/auth-perm-design/01-database-schema.md §audit_log
 *
 * Audit entries persist across user/org deletions — hence the denormalized
 * actor_name / target_name columns and absence of FKs.
 */
export type AuditActorType = 'user' | 'service_account' | 'system';
export type AuditOutcome = 'success' | 'failure';

export interface AuditLogEntry {
  id: string;
  /** ISO-8601 timestamp. */
  timestamp: string;
  /** Dotted event name, e.g. 'user.login' | 'team.member_added' | 'dashboard.permission_changed'. */
  action: string;
  actorType: AuditActorType;
  actorId: string | null;
  /** Snapshot at time of event — denormalized so log remains readable post-deletion. */
  actorName: string | null;
  orgId: string | null;
  /** 'user' | 'team' | 'dashboard' | 'folder' | etc. */
  targetType: string | null;
  targetId: string | null;
  targetName: string | null;
  outcome: AuditOutcome;
  /** JSON blob (stored as TEXT) of action-specific fields. */
  metadata: string | null;
  ip: string | null;
  userAgent: string | null;
}

export interface NewAuditLogEntry {
  id?: string;
  timestamp?: string;
  action: string;
  actorType: AuditActorType;
  actorId?: string | null;
  actorName?: string | null;
  orgId?: string | null;
  targetType?: string | null;
  targetId?: string | null;
  targetName?: string | null;
  outcome: AuditOutcome;
  metadata?: unknown;
  ip?: string | null;
  userAgent?: string | null;
}

export interface AuditLogQuery {
  actorId?: string;
  targetId?: string;
  action?: string;
  orgId?: string;
  outcome?: AuditOutcome;
  /** Inclusive lower bound (ISO-8601). */
  from?: string;
  /** Inclusive upper bound (ISO-8601). */
  to?: string;
  limit?: number;
  offset?: number;
}
