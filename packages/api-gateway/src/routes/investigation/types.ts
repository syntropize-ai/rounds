// Investigation API - HTTP request/response types

import type { Investigation, InvestigationStatus } from '@agentic-obs/common';

// -- Request bodies

export interface CreateInvestigationBody {
  /** Natural-language question from the user */
  question: string;
  /** Optional entity hint (e.g. "checkout-service") */
  entity?: string;
  /** Optional time range hint (ISO-8601 strings) */
  timeRange?: { start: string; end: string };
}

export interface FollowUpBody {
  question: string;
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

// -- Response shapes

export interface InvestigationSummary {
  id: string;
  status: InvestigationStatus;
  intent: string;
  userId: string;
  createdAt: string;
  updatedAt: string;
}

export interface PlanResponse {
  investigationId: string;
  plan: Investigation['plan'];
}

export interface FollowUpRecord {
  id: string;
  investigationId: string;
  question: string;
  createdAt: string;
}

export interface FeedbackResponse {
  received: boolean;
  investigationId: string;
}

export interface StoredFeedback extends FeedbackBody {
  id: string;
  investigationId: string;
  createdAt: string;
}

// -- SSE event shapes

export type SseEventType =
  | 'investigation:created'
  | 'investigation:status'
  | 'investigation:step'
  | 'investigation:hypothesis'
  | 'investigation:complete'
  | 'investigation:error'
  | 'connected'
  | 'feed_item';

export interface SseEvent<T = unknown> {
  type: SseEventType;
  data: T;
}
