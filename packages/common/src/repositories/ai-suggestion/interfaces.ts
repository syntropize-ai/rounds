/**
 * Repository interface for AI suggestions (Wave 2 / step 3).
 *
 * Per-user inbox of AI-generated proposals (one inbox, not 6 channels).
 * The dedup_key uniqueness per (user_id, dedup_key) lets generators
 * re-run idempotently — running the missing-dashboard generator twice
 * does not create two rows.
 *
 * Implementations:
 *   - packages/data-layer/src/repository/memory/ai-suggestion.ts
 *   - packages/data-layer/src/repository/sqlite/ai-suggestion.ts
 *   - packages/data-layer/src/repository/postgres/ai-suggestion.ts
 */

import type {
  AiSuggestion,
  AiSuggestionState,
  NewAiSuggestion,
} from '../../models/ai-suggestion.js';

export interface IAiSuggestionRepository {
  /** Upserts by (user_id, dedup_key). Returns the row whether inserted or no-op. */
  create(input: NewAiSuggestion): Promise<AiSuggestion>;

  findById(id: string): Promise<AiSuggestion | null>;

  /**
   * Returns rows that should currently be visible to the user. That is:
   *   - state = 'open', OR
   *   - state = 'snoozed' AND snoozed_until <= now()  (resurfaced)
   */
  findOpenForUser(userId: string, orgId: string, now?: string): Promise<AiSuggestion[]>;

  /**
   * State transitions. `snoozedUntil` only honored when state='snoozed'.
   * Returns null when the row is missing.
   */
  updateState(
    id: string,
    state: AiSuggestionState,
    snoozedUntil?: string | null,
  ): Promise<AiSuggestion | null>;

  /**
   * Bulk-snooze all open suggestions for a user. Returns the count touched.
   */
  snoozeAllForUser(userId: string, orgId: string, snoozedUntil: string): Promise<number>;
}
