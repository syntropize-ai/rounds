/**
 * Grafana ref: pkg/services/preference/model.go::Preference
 * See docs/auth-perm-design/01-database-schema.md §preferences
 *
 * Resolution order when reading prefs for a user: user row > team row > org row.
 * Writing is explicit: callers specify (orgId, userId?, teamId?) which of the
 * three scopes they want to set.
 */
export interface Preferences {
  id: string;
  orgId: string;
  userId: string | null;
  teamId: string | null;
  version: number;
  homeDashboardUid: string | null;
  timezone: string | null;
  weekStart: string | null;
  theme: string | null;
  locale: string | null;
  jsonData: string | null;
  created: string;
  updated: string;
}

export interface NewPreferences {
  id?: string;
  orgId: string;
  userId?: string | null;
  teamId?: string | null;
  homeDashboardUid?: string | null;
  timezone?: string | null;
  weekStart?: string | null;
  theme?: string | null;
  locale?: string | null;
  jsonData?: string | null;
}

export interface PreferencesPatch {
  homeDashboardUid?: string | null;
  timezone?: string | null;
  weekStart?: string | null;
  theme?: string | null;
  locale?: string | null;
  jsonData?: string | null;
}
