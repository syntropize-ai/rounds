// Investigation follow-up and feedback types consumed by investigation repositories.

export interface FollowUpRecord {
  id: string;
  investigationId: string;
  question: string;
  createdAt: string;
}

export interface FeedbackBody {
  /** Whether the investigation result was useful */
  helpful: boolean;
  /** Optional free-text comment from the user */
  comment?: string;
  /** Explicit verdict on the identified root cause */
  rootCauseVerdict?: 'correct' | 'wrong' | 'partially_correct';
  /** Per-hypothesis verdicts (replaces single hypothesisId for multi-hypothesis feedback) */
  hypothesisFeedbacks?: Array<{
    hypothesisId: string;
    verdict: 'correct' | 'wrong';
    comment?: string;
  }>;
  /** Per-action verdicts */
  actionFeedbacks?: Array<{
    actionId: string;
    helpful: boolean;
    comment?: string;
  }>;
}

export interface StoredFeedback extends FeedbackBody {
  id: string;
  investigationId: string;
  createdAt: string;
}
