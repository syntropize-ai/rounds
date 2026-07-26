import type { Hypothesis } from './hypothesis.js';
import type { Action } from './action.js';
import type { Evidence } from './evidence.js';
import type { Symptom } from './symptom.js';
import type { StructuredIntent } from './intent.js';

export type InvestigationStatus =
  | 'planning'
  | 'investigating'
  | 'evidencing'
  | 'explaining'
  | 'acting'
  | 'verifying'
  | 'completed'
  | 'failed';

/**
 * The statuses that mean work is still happening.
 *
 * Listed rather than derived by excluding `completed` and `failed`, and shared
 * rather than restated. Both spellings existed — the SSE stream service and the
 * detail page each asked "is this terminal?" as "not completed and not failed"
 * — so any status a build did not recognise counted as in-flight: polled every
 * few seconds forever, rendered with the animated "in progress" chrome, and
 * described as actively working. A stuck or cancelled investigation looked
 * busy, which is the reassuring answer rather than the true one.
 *
 * An allowlist fails the other way. Something unrecognised stops being
 * refreshed, which is visible and cheap to notice, instead of becoming a
 * permanent background request nobody can account for.
 */
export const ACTIVE_INVESTIGATION_STATUSES: ReadonlySet<string> = new Set<InvestigationStatus>([
  'planning',
  'investigating',
  'evidencing',
  'explaining',
  'acting',
  'verifying',
]);

/** True only for a status we recognise as still running. */
export function isInvestigationActive(status: string): boolean {
  return ACTIVE_INVESTIGATION_STATUSES.has(status);
}

export interface InvestigationStepCost {
  tokens: number;
  queries: number;
  latencyMs: number;
}

export interface InvestigationStep {
  id: string;
  type: string;
  description: string;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'skipped';
  result?: unknown;
  cost?: InvestigationStepCost;
}

export interface StopCondition {
  type: 'high_confidence_hypothesis' | 'max_cost' | 'max_queries' | 'time_budget';
  params: Record<string, number>;
}

export interface InvestigationPlan {
  entity: string;
  objective: string;
  steps: InvestigationStep[];
  stopConditions: StopCondition[];
}

export interface Investigation {
  id: string;
  sessionId: string;
  userId: string;
  intent: string;
  structuredIntent: StructuredIntent;
  plan: InvestigationPlan;
  status: InvestigationStatus;
  hypotheses: Hypothesis[];
  actions: Action[];
  evidence: Evidence[];
  symptoms: Symptom[];
  workspaceId?: string;
  createdAt: string;
  updatedAt: string;
}
