/**
 * AI Suggestion model — Wave 2 step 3.
 *
 * One inbox on Home (not 6 notification channels). Each suggestion is an
 * AI-generated proposal: create-dashboard, archive-stale, merge-duplicate.
 * Per-user, not org-wide.
 */

export type AiSuggestionKind =
  | 'missing_dashboard'
  | 'stale_draft'
  | 'duplicate_dashboard';

export type AiSuggestionState = 'open' | 'accepted' | 'snoozed' | 'dismissed';

export type AiSuggestionActionKind =
  | 'create_dashboard'
  | 'archive_resources'
  | 'merge_dashboards';

export interface AiSuggestion {
  id: string;
  orgId: string;
  userId: string;
  kind: AiSuggestionKind;
  title: string;
  body: string;
  actionKind: AiSuggestionActionKind | null;
  actionPayload: Record<string, unknown> | null;
  state: AiSuggestionState;
  snoozedUntil: string | null;
  createdAt: string;
  updatedAt: string;
  dedupKey: string;
}

export interface NewAiSuggestion {
  id?: string;
  orgId: string;
  userId: string;
  kind: AiSuggestionKind;
  title: string;
  body: string;
  actionKind?: AiSuggestionActionKind | null;
  actionPayload?: Record<string, unknown> | null;
  dedupKey: string;
}
