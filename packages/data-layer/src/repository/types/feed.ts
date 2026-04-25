// Feed item types consumed by feed repositories.

export type FeedEventType =
  | 'investigation_complete'
  | 'anomaly_detected'
  | 'change_impact'
  | 'incident_created'
  | 'proactive_investigation'
  | 'action_executed'
  | 'approval_requested'
  | 'approval_resolved'
  | 'verification_complete';

export type FeedSeverity = 'low' | 'medium' | 'high' | 'critical';
export type FeedStatus = 'unread' | 'read';

/**
 * Top-level feedback on a feed item.
 * - "useful", "not_useful" - general helpfulness signal
 * - "root_cause_correct" - root cause identified was confirmed correct
 * - "root_cause_wrong" - root cause identified was wrong
 * - "partially_correct" - root cause was partly right (some hypotheses correct)
 */
export type FeedFeedback =
  | 'useful'
  | 'not_useful'
  | 'root_cause_correct'
  | 'root_cause_wrong'
  | 'partially_correct';

/** Per-hypothesis verdict from the user - for fine-grained accuracy tracking. */
export interface HypothesisFeedback {
  hypothesisId: string;
  verdict: 'correct' | 'wrong';
  /** Optional free-text comment from the user */
  comment?: string;
}

/** Per-action verdict - was a recommended action actually helpful? */
export interface ActionFeedback {
  actionId: string;
  helpful: boolean;
  /** Optional free-text comment from the user */
  comment?: string;
}

export interface FeedItem {
  id: string;
  type: FeedEventType;
  title: string;
  summary: string;
  severity: FeedSeverity;
  status: FeedStatus;
  feedback?: FeedFeedback;
  /** Free-text supplement attached to the top-level feedback */
  feedbackComment?: string;
  /** Per-hypothesis verdicts; one entry per hypothesis ID (last write wins per ID) */
  hypothesisFeedback?: HypothesisFeedback[];
  /** Per-action verdicts; one entry per action ID (last write wins per ID) */
  actionFeedback?: ActionFeedback[];
  investigationId?: string;
  /**
   * True when the user navigated from this feed item into an investigation,
   * indicating the proactive finding was actionable. Phase 2 will use this
   * to close the feedback loop.
   */
  followed_up?: boolean;
  createdAt: string;
}

// -- Stats

export interface FeedbackStats {
  total: number;
  withFeedback: number;
  /** Fraction of items that received any feedback (0-1) */
  feedbackRate: number;
  byVerdict: Record<FeedFeedback, number>;
  hypothesisVerdicts: {
    correct: number;
    wrong: number;
  };
  actionVerdicts: {
    helpful: number;
    notHelpful: number;
  };
  /** Number of feed items marked as followed-up by the user. */
  followedUpCount: number;
  /**
   * Fraction of proactive feed items (anomaly_detected / change_impact) where
   * the user followed up. `0` when no proactive items exist.
   */
  proactiveHitRate: number;
}

export interface FeedListOptions {
  page?: number;
  limit?: number;
  type?: FeedEventType;
  severity?: FeedSeverity;
  status?: FeedStatus;
  tenantId?: string;
}

export interface FeedPage {
  items: FeedItem[];
  total: number;
  page: number;
  limit: number;
}
