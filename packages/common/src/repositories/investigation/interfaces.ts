/**
 * Repository interface for investigations (W6 / T6.A2).
 *
 * Replaces the in-memory `InvestigationStore` at
 * `packages/data-layer/src/stores/investigation-store.ts`. The SQLite
 * implementation lives at
 * `packages/data-layer/src/repository/sqlite/investigation.ts`
 * (`InvestigationRepository`) and is backed by the `investigations`,
 * `investigation_follow_ups`, `investigation_feedback`, and
 * `investigation_conclusions` tables already present in
 * `packages/data-layer/src/db/sqlite-schema.ts`.
 *
 * Semantics notes (preserved from the store):
 *   - `findById` returns `null` when the investigation does not exist
 *     (the old store returned `undefined` — repositories use `null`).
 *   - Sub-entity list methods (`getFollowUps`, `listFeedback`) return
 *     an empty array, never `null`/`undefined`.
 *   - `findAll`/`findByWorkspace` hide archived investigations by
 *     default. `getArchived` returns exactly the archived ones.
 *   - `archive`/`restoreFromArchive` flip the `archived` flag on the
 *     primary row; no data is moved between tables.
 */

import type {
  Investigation,
  InvestigationStatus,
} from '../../models/investigation.js';
import type { Hypothesis } from '../../models/hypothesis.js';
import type { Evidence } from '../../models/evidence.js';
import type { ExplanationResult } from '../../models/explanation.js';

// -- Inputs / sub-entity records --------------------------------------

/** Creation parameters accepted by the legacy `InvestigationStore.create`. */
export interface CreateInvestigationInput {
  question: string;
  sessionId: string;
  userId: string;
  entity?: string;
  timeRange?: { start: string; end: string };
  tenantId?: string;
  workspaceId?: string;
}

export interface FollowUpRecord {
  id: string;
  investigationId: string;
  question: string;
  createdAt: string;
}

export interface HypothesisVerdict {
  hypothesisId: string;
  verdict: 'correct' | 'wrong';
  comment?: string;
}

export interface ActionVerdict {
  actionId: string;
  helpful: boolean;
  comment?: string;
}

export interface FeedbackBody {
  helpful: boolean;
  comment?: string;
  rootCauseVerdict?: 'correct' | 'wrong' | 'partially_correct';
  hypothesisFeedbacks?: HypothesisVerdict[];
  actionFeedbacks?: ActionVerdict[];
}

export interface StoredFeedback extends FeedbackBody {
  id: string;
  investigationId: string;
  createdAt: string;
}

/** Result payload accepted by `updateResult`. */
export interface UpdateResultInput {
  hypotheses: Hypothesis[];
  evidence: Evidence[];
  conclusion: ExplanationResult | null;
}

// -- Repository ------------------------------------------------------

export interface IInvestigationRepository {
  // Primary entity
  create(input: CreateInvestigationInput): Promise<Investigation>;
  findById(id: string): Promise<Investigation | null>;
  findAll(tenantId?: string): Promise<Investigation[]>;
  findByWorkspace(workspaceId: string): Promise<Investigation[]>;
  delete(id: string): Promise<boolean>;

  // Write-backs from the orchestrator
  updateStatus(id: string, status: InvestigationStatus): Promise<Investigation | null>;
  updatePlan(id: string, plan: Investigation['plan']): Promise<Investigation | null>;
  updateResult(id: string, result: UpdateResultInput): Promise<Investigation | null>;

  // Archive flow (eviction + manual archive)
  archive(id: string): Promise<Investigation | null>;
  restoreFromArchive(id: string): Promise<Investigation | null>;
  restoreFromArchiveInWorkspace(id: string, workspaceId: string): Promise<Investigation | null>;
  getArchived(): Promise<Investigation[]>;

  // Follow-ups (one-to-many)
  addFollowUp(investigationId: string, question: string): Promise<FollowUpRecord>;
  getFollowUps(investigationId: string): Promise<FollowUpRecord[]>;

  // Feedback (one-to-many)
  addFeedback(investigationId: string, body: FeedbackBody): Promise<StoredFeedback>;
  listFeedback(investigationId: string): Promise<StoredFeedback[]>;

  // Conclusions (one-to-one)
  getConclusion(id: string): Promise<ExplanationResult | null>;
  setConclusion(id: string, conclusion: ExplanationResult): Promise<void>;
}
