/**
 * Grafana ref: pkg/services/quota/model.go::Quota
 * See docs/auth-perm-design/01-database-schema.md §quota
 *
 * Exactly one of (orgId, userId) is non-null. `limitVal` = -1 means unlimited.
 */
export type QuotaTarget =
  | 'dashboards'
  | 'users'
  | 'datasources'
  | 'api_keys'
  | 'service_accounts'
  | 'folders'
  | 'alert_rules';

export interface Quota {
  id: string;
  orgId: string | null;
  userId: string | null;
  target: QuotaTarget | string;
  limitVal: number;
  created: string;
  updated: string;
}

export interface NewQuota {
  id?: string;
  orgId?: string | null;
  userId?: string | null;
  target: QuotaTarget | string;
  limitVal: number;
}

export interface QuotaUsage {
  target: QuotaTarget | string;
  /** Current count of entities of this kind. */
  used: number;
  /** Configured limit, -1 = unlimited. */
  limit: number;
}
