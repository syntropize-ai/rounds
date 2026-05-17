import { pgAll, pgRun } from './pg-helpers.js';
import { sql } from 'drizzle-orm';
import { randomUUID } from 'crypto';
import type {
  Investigation,
  InvestigationStatus,
  CreateInvestigationInput,
  UpdateResultInput,
  IInvestigationRepository,
} from '@agentic-obs/common';
import type { ExplanationResult } from '@agentic-obs/common';
import type { FollowUpRecord, FeedbackBody, StoredFeedback } from '../types/investigation.js';

// =====================================================================
// Postgres implementation of the canonical investigation repository contract.
//
// =====================================================================

// -- Row types --------------------------------------------------------

interface InvestigationRow {
  id: string;
  tenant_id: string;
  session_id: string | null;
  user_id: string | null;
  intent: string;
  structured_intent: string | null;
  plan: string | null;
  status: string;
  hypotheses: string;
  actions: string;
  evidence: string;
  symptoms: string;
  workspace_id: string | null;
  org_id: string;
  archived: number;
  created_at: string;
  updated_at: string;
}

interface FollowUpRow {
  id: string;
  investigation_id: string;
  question: string;
  created_at: string;
}

interface FeedbackRow {
  id: string;
  investigation_id: string;
  helpful: number;
  comment: string | null;
  root_cause_verdict: string | null;
  hypothesis_feedbacks: string | null;
  action_feedbacks: string | null;
  created_at: string;
}

interface ConclusionRow {
  investigation_id: string;
  conclusion: string;
}

// -- JSON helpers -----------------------------------------------------

function parseJson<T>(raw: string | null | undefined, fallback: T): T {
  if (raw === null || raw === undefined || raw === '') return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function nowIso(): string {
  return new Date().toISOString();
}

function emptyPlan(entity = '', objective = ''): Investigation['plan'] {
  return { entity, objective, steps: [], stopConditions: [] };
}

function rowToInvestigationV6(r: InvestigationRow): Investigation {
  return {
    id: r.id,
    sessionId: r.session_id ?? '',
    userId: r.user_id ?? '',
    intent: r.intent,
    structuredIntent: parseJson<Investigation['structuredIntent']>(
      r.structured_intent,
      {
        taskType: 'general_query',
        entity: '',
        timeRange: { start: '', end: '' },
        goal: r.intent,
      },
    ),
    plan: parseJson<Investigation['plan']>(r.plan, emptyPlan()),
    status: r.status as Investigation['status'],
    hypotheses: parseJson<Investigation['hypotheses']>(r.hypotheses, []),
    actions: parseJson<Investigation['actions']>(r.actions, []),
    evidence: parseJson<Investigation['evidence']>(r.evidence, []),
    symptoms: parseJson<Investigation['symptoms']>(r.symptoms, []),
    ...(r.workspace_id ? { workspaceId: r.workspace_id } : {}),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function rowToFollowUp(r: FollowUpRow): FollowUpRecord {
  return {
    id: r.id,
    investigationId: r.investigation_id,
    question: r.question,
    createdAt: r.created_at,
  };
}

function rowToFeedback(r: FeedbackRow): StoredFeedback {
  const base: StoredFeedback = {
    id: r.id,
    investigationId: r.investigation_id,
    helpful: r.helpful === 1,
    createdAt: r.created_at,
  };
  if (r.comment !== null) base.comment = r.comment;
  if (r.root_cause_verdict !== null) {
    base.rootCauseVerdict = r.root_cause_verdict as StoredFeedback['rootCauseVerdict'];
  }
  const hyp = parseJson<StoredFeedback['hypothesisFeedbacks'] | null>(
    r.hypothesis_feedbacks,
    null,
  );
  if (hyp !== null) base.hypothesisFeedbacks = hyp;
  const act = parseJson<StoredFeedback['actionFeedbacks'] | null>(
    r.action_feedbacks,
    null,
  );
  if (act !== null) base.actionFeedbacks = act;
  return base;
}

// -- Repository -------------------------------------------------------

/**
 * SQLite-backed replacement for `defaultInvestigationStore`.
 *
 * Backing tables (migration V1 / 015):
 *   - `investigations`
 *   - `investigation_follow_ups`   (one-to-many)
 *   - `investigation_feedback`     (one-to-many)
 *   - `investigation_conclusions`  (one-to-one via PK = investigation_id)
 *
 * Soft FK maps (`tenants`, `workspaces`) from the old store are derived
 * columns on `investigations` and not tracked separately.
 */
export class PostgresInvestigationRepository implements IInvestigationRepository {
  constructor(private readonly db: any) {}

  // -- Primary entity

  async create(input: CreateInvestigationInput): Promise<Investigation> {
    const now = nowIso();
    const id = `inv_${randomUUID()}`;
    const timeRange = input.timeRange ?? {
      start: new Date(Date.now() - 3600_000).toISOString(),
      end: now,
    };
    const entity = input.entity ?? '';
    const structuredIntent: Investigation['structuredIntent'] = {
      taskType: 'general_query',
      entity,
      timeRange,
      goal: input.question,
    };
    const plan = emptyPlan(entity, input.question);
    const tenantId = input.tenantId ?? '';
    const workspaceId = input.workspaceId ?? null;

    await pgRun(this.db, sql`
      INSERT INTO investigations (
        id, tenant_id, session_id, user_id, intent,
        structured_intent, plan, status,
        hypotheses, actions, evidence, symptoms,
        workspace_id, archived,
        created_at, updated_at
      ) VALUES (
        ${id},
        ${tenantId},
        ${input.sessionId},
        ${input.userId},
        ${input.question},
        ${JSON.stringify(structuredIntent)},
        ${JSON.stringify(plan)},
        ${'planning'},
        ${'[]'}, ${'[]'}, ${'[]'}, ${'[]'},
        ${workspaceId},
        ${0},
        ${now},
        ${now}
      )
    `);

    const saved = await this.findById(id);
    if (!saved) {
      throw new Error(`[InvestigationRepository] create: row ${id} not found after insert`);
    }
    return saved;
  }

  async findById(id: string): Promise<Investigation | null> {
    const rows = await pgAll<InvestigationRow>(this.db,
      sql`SELECT * FROM investigations WHERE id = ${id}`,
    );
    if (rows.length === 0) return null;
    return rowToInvestigationV6(rows[0]!);
  }

  async findAll(tenantId?: string): Promise<Investigation[]> {
    const rows =
      tenantId === undefined
        ? await pgAll<InvestigationRow>(this.db, sql`
            SELECT * FROM investigations
            WHERE archived = 0
            ORDER BY created_at DESC
          `)
        : await pgAll<InvestigationRow>(this.db, sql`
            SELECT * FROM investigations
            WHERE archived = 0 AND tenant_id = ${tenantId}
            ORDER BY created_at DESC
          `);
    return rows.map(rowToInvestigationV6);
  }

  async findByWorkspace(workspaceId: string): Promise<Investigation[]> {
    const rows = await pgAll<InvestigationRow>(this.db, sql`
      SELECT * FROM investigations
      WHERE archived = 0 AND workspace_id = ${workspaceId}
      ORDER BY created_at DESC
    `);
    return rows.map(rowToInvestigationV6);
  }

  async delete(id: string): Promise<boolean> {
    // `findById` does not filter by archived, so this catches both
    // active and archived rows.
    const existing = await this.findById(id);
    if (!existing) return false;
    // FK cascades remove follow_ups / feedback / conclusions.
    await pgRun(this.db, sql`DELETE FROM investigations WHERE id = ${id}`);
    return true;
  }

  // -- Write-backs

  async updateStatus(
    id: string,
    status: InvestigationStatus,
  ): Promise<Investigation | null> {
    const existing = await this.findById(id);
    if (!existing) return null;
    await pgRun(this.db, sql`
      UPDATE investigations
      SET status = ${status}, updated_at = ${nowIso()}
      WHERE id = ${id}
    `);
    return this.findById(id);
  }

  async updatePlan(
    id: string,
    plan: Investigation['plan'],
  ): Promise<Investigation | null> {
    const existing = await this.findById(id);
    if (!existing) return null;
    await pgRun(this.db, sql`
      UPDATE investigations
      SET plan = ${JSON.stringify(plan)}, updated_at = ${nowIso()}
      WHERE id = ${id}
    `);
    return this.findById(id);
  }

  async updateResult(
    id: string,
    result: UpdateResultInput,
  ): Promise<Investigation | null> {
    const existing = await this.findById(id);
    if (!existing) return null;
    await pgRun(this.db, sql`
      UPDATE investigations
      SET hypotheses = ${JSON.stringify(result.hypotheses)},
          evidence   = ${JSON.stringify(result.evidence)},
          updated_at = ${nowIso()}
      WHERE id = ${id}
    `);
    if (result.conclusion) {
      await this.setConclusion(id, result.conclusion);
    }
    return this.findById(id);
  }

  // -- Archive flow

  async archive(id: string): Promise<Investigation | null> {
    const rows = await pgAll<{ id: string }>(this.db,
      sql`SELECT id FROM investigations WHERE id = ${id}`,
    );
    if (rows.length === 0) return null;
    await pgRun(this.db, sql`
      UPDATE investigations
      SET archived = 1, updated_at = ${nowIso()}
      WHERE id = ${id}
    `);
    const rowAfter = await pgAll<InvestigationRow>(this.db,
      sql`SELECT * FROM investigations WHERE id = ${id}`,
    );
    return rowAfter.length === 0 ? null : rowToInvestigationV6(rowAfter[0]!);
  }

  async restoreFromArchive(id: string): Promise<Investigation | null> {
    const rows = await pgAll<InvestigationRow>(this.db,
      sql`SELECT * FROM investigations WHERE id = ${id} AND archived = 1`,
    );
    if (rows.length === 0) return null;
    await pgRun(this.db, sql`
      UPDATE investigations
      SET archived = 0, updated_at = ${nowIso()}
      WHERE id = ${id}
    `);
    return this.findById(id);
  }

  async restoreFromArchiveInWorkspace(id: string, workspaceId: string): Promise<Investigation | null> {
    const rows = await pgAll<InvestigationRow>(this.db, sql`
      SELECT * FROM investigations
      WHERE id = ${id}
        AND workspace_id = ${workspaceId}
        AND archived = 1
    `);
    if (rows.length === 0) return null;
    await pgRun(this.db, sql`
      UPDATE investigations
      SET archived = 0, updated_at = ${nowIso()}
      WHERE id = ${id}
        AND workspace_id = ${workspaceId}
        AND archived = 1
    `);
    return this.findById(id);
  }

  async getArchived(): Promise<Investigation[]> {
    const rows = await pgAll<InvestigationRow>(this.db, sql`
      SELECT * FROM investigations
      WHERE archived = 1
      ORDER BY created_at DESC
    `);
    return rows.map(rowToInvestigationV6);
  }

  // -- Follow-ups

  async addFollowUp(
    investigationId: string,
    question: string,
  ): Promise<FollowUpRecord> {
    const id = `fu_${randomUUID()}`;
    const createdAt = nowIso();
    await pgRun(this.db, sql`
      INSERT INTO investigation_follow_ups (id, investigation_id, question, created_at)
      VALUES (${id}, ${investigationId}, ${question}, ${createdAt})
    `);
    return { id, investigationId, question, createdAt };
  }

  async getFollowUps(investigationId: string): Promise<FollowUpRecord[]> {
    const rows = await pgAll<FollowUpRow>(this.db, sql`
      SELECT * FROM investigation_follow_ups
      WHERE investigation_id = ${investigationId}
      ORDER BY created_at ASC
    `);
    return rows.map(rowToFollowUp);
  }

  // -- Feedback

  async addFeedback(
    investigationId: string,
    body: FeedbackBody,
  ): Promise<StoredFeedback> {
    const id = `fb_${randomUUID()}`;
    const createdAt = nowIso();
    await pgRun(this.db, sql`
      INSERT INTO investigation_feedback (
        id, investigation_id, helpful, comment,
        root_cause_verdict, hypothesis_feedbacks, action_feedbacks,
        created_at
      ) VALUES (
        ${id},
        ${investigationId},
        ${body.helpful ? 1 : 0},
        ${body.comment ?? null},
        ${body.rootCauseVerdict ?? null},
        ${body.hypothesisFeedbacks ? JSON.stringify(body.hypothesisFeedbacks) : null},
        ${body.actionFeedbacks ? JSON.stringify(body.actionFeedbacks) : null},
        ${createdAt}
      )
    `);
    const saved: StoredFeedback = {
      id,
      investigationId,
      helpful: body.helpful,
      createdAt,
    };
    if (body.comment !== undefined) saved.comment = body.comment;
    if (body.rootCauseVerdict !== undefined) saved.rootCauseVerdict = body.rootCauseVerdict;
    if (body.hypothesisFeedbacks !== undefined) saved.hypothesisFeedbacks = body.hypothesisFeedbacks;
    if (body.actionFeedbacks !== undefined) saved.actionFeedbacks = body.actionFeedbacks;
    return saved;
  }

  async listFeedback(investigationId: string): Promise<StoredFeedback[]> {
    const rows = await pgAll<FeedbackRow>(this.db, sql`
      SELECT * FROM investigation_feedback
      WHERE investigation_id = ${investigationId}
      ORDER BY created_at ASC
    `);
    return rows.map(rowToFeedback);
  }

  // -- Conclusions

  async getConclusion(id: string): Promise<ExplanationResult | null> {
    const rows = await pgAll<ConclusionRow>(this.db, sql`
      SELECT * FROM investigation_conclusions WHERE investigation_id = ${id}
    `);
    if (rows.length === 0) return null;
    return parseJson<ExplanationResult | null>(rows[0]!.conclusion, null);
  }

  async setConclusion(id: string, conclusion: ExplanationResult): Promise<void> {
    await pgRun(this.db, sql`
      INSERT INTO investigation_conclusions (investigation_id, conclusion)
      VALUES (${id}, ${JSON.stringify(conclusion)})
      ON CONFLICT(investigation_id) DO UPDATE SET
        conclusion = excluded.conclusion
    `);
  }
}
