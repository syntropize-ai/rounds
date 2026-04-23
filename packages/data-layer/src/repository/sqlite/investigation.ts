import { eq, and, sql } from 'drizzle-orm';
import { randomUUID } from 'crypto';
import type {
  Investigation,
  InvestigationStatus,
  Hypothesis,
  Evidence,
} from '@agentic-obs/common';
import type { ExplanationResult } from '@agentic-obs/common';
import type { SqliteClient } from '../../db/sqlite-client.js';
import { toJsonColumn } from '../json-column.js';
import {
  investigations,
  investigationFollowUps,
  investigationFeedback,
  investigationConclusions,
} from '../../db/sqlite-schema.js';
import type {
  IInvestigationRepository,
  InvestigationFindAllOptions,
} from '../interfaces.js';
import type { FollowUpRecord, FeedbackBody, StoredFeedback } from '../../stores/investigation-store.js';

type DbRow = typeof investigations.$inferSelect;

function rowToInvestigation(row: DbRow): Investigation {
  return {
    id: row.id,
    sessionId: row.sessionId ?? '',
    userId: row.userId ?? '',
    intent: row.intent,
    structuredIntent: (row.structuredIntent ?? {}) as Investigation['structuredIntent'],
    plan: (row.plan ?? { entity: '', objective: '', steps: [], stopConditions: [] }) as Investigation['plan'],
    status: row.status as Investigation['status'],
    hypotheses: (row.hypotheses as Investigation['hypotheses']) ?? [],
    evidence: (row.evidence as Investigation['evidence']) ?? [],
    symptoms: (row.symptoms as Investigation['symptoms']) ?? [],
    actions: (row.actions as Investigation['actions']) ?? [],
    workspaceId: row.workspaceId ?? undefined,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export class SqliteInvestigationRepository implements IInvestigationRepository {
  constructor(private readonly db: SqliteClient) {}

  async findById(id: string): Promise<Investigation | undefined> {
    const [row] = await this.db.select().from(investigations).where(eq(investigations.id, id));
    return row ? rowToInvestigation(row) : undefined;
  }

  async findAll(opts: InvestigationFindAllOptions = {}): Promise<Investigation[]> {
    const conditions = [eq(investigations.archived, false)];
    if (opts.tenantId) conditions.push(eq(investigations.tenantId, opts.tenantId));
    if (opts.status) conditions.push(eq(investigations.status, opts.status));

    const rows = await this.db
      .select()
      .from(investigations)
      .where(and(...conditions))
      .limit(opts.limit ?? 100)
      .offset(opts.offset ?? 0);

    return rows.map(rowToInvestigation);
  }

  async create(
    data: (Omit<Investigation, 'id' | 'createdAt'> & { id?: string })
      | { question: string; sessionId: string; userId: string; entity?: string; timeRange?: { start: string; end: string }; tenantId?: string; workspaceId?: string },
  ): Promise<Investigation> {
    const now = new Date().toISOString();

    // Support both IGatewayInvestigationStore.create({ question }) and
    // IRepository<Investigation>.create({ intent }) signatures.
    const isGatewayParams = 'question' in data;
    const intent = isGatewayParams ? (data as { question: string }).question : (data as Investigation).intent;
    const sessionId = data.sessionId;
    const userId = data.userId;
    const tenantId = (data as Record<string, unknown>).tenantId as string | undefined ?? 'default';
    const workspaceId = (data as Record<string, unknown>).workspaceId as string | undefined;
    const entity = isGatewayParams ? (data as { entity?: string }).entity ?? '' : '';
    const timeRange = isGatewayParams
      ? (data as { timeRange?: { start: string; end: string } }).timeRange ?? { start: new Date(Date.now() - 3600_000).toISOString(), end: now }
      : { start: new Date(Date.now() - 3600_000).toISOString(), end: now };

    const structuredIntent = isGatewayParams
      ? { taskType: 'general_query' as const, entity, timeRange, goal: intent }
      : (data as Investigation).structuredIntent;
    const plan = isGatewayParams
      ? { entity, objective: intent, steps: [] as unknown[], stopConditions: [] as string[] }
      : (data as Investigation).plan;
    const status = isGatewayParams ? 'planning' : (data as Investigation).status;

    const id = ('id' in data && data.id) ? data.id as string : `inv_${randomUUID().slice(0, 8)}`;
    const [row] = await this.db
      .insert(investigations)
      .values({
        id,
        tenantId,
        sessionId,
        userId,
        intent,
        structuredIntent: toJsonColumn(structuredIntent),
        plan: toJsonColumn(plan),
        status,
        hypotheses: isGatewayParams ? [] : (data as Investigation).hypotheses,
        actions: isGatewayParams ? [] : ((data as Investigation).actions ?? []),
        evidence: isGatewayParams ? [] : (data as Investigation).evidence,
        symptoms: isGatewayParams ? [] : (data as Investigation).symptoms,
        workspaceId,
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    return rowToInvestigation(row!);
  }

  async update(
    id: string,
    patch: Partial<Omit<Investigation, 'id'>>,
  ): Promise<Investigation | undefined> {
    const sets: Record<string, unknown> = { updatedAt: new Date().toISOString() };
    if (patch.status !== undefined) sets.status = patch.status;
    if (patch.plan !== undefined) sets.plan = patch.plan;
    if (patch.hypotheses !== undefined) sets.hypotheses = patch.hypotheses;
    if (patch.evidence !== undefined) sets.evidence = patch.evidence;
    if (patch.symptoms !== undefined) sets.symptoms = patch.symptoms;
    if (patch.actions !== undefined) sets.actions = patch.actions;
    if (patch.intent !== undefined) sets.intent = patch.intent;

    const [row] = await this.db
      .update(investigations)
      .set(sets)
      .where(eq(investigations.id, id))
      .returning();

    return row ? rowToInvestigation(row) : undefined;
  }

  async delete(id: string): Promise<boolean> {
    const result = await this.db.delete(investigations).where(eq(investigations.id, id)).returning();
    return result.length > 0;
  }

  async count(): Promise<number> {
    const result = await this.db
      .select({ count: sql<number>`count(*)` })
      .from(investigations)
      .where(eq(investigations.archived, false));
    return Number(result[0]?.count ?? 0);
  }

  async findBySession(sessionId: string): Promise<Investigation[]> {
    const rows = await this.db
      .select()
      .from(investigations)
      .where(eq(investigations.sessionId, sessionId));
    return rows.map(rowToInvestigation);
  }

  async findByUser(userId: string, tenantId?: string): Promise<Investigation[]> {
    const conditions = [eq(investigations.userId, userId), eq(investigations.archived, false)];
    if (tenantId) conditions.push(eq(investigations.tenantId, tenantId));
    const rows = await this.db
      .select()
      .from(investigations)
      .where(and(...conditions));
    return rows.map(rowToInvestigation);
  }

  async findByWorkspace(workspaceId: string): Promise<Investigation[]> {
    const rows = await this.db
      .select()
      .from(investigations)
      .where(and(eq(investigations.workspaceId, workspaceId), eq(investigations.archived, false)));
    return rows.map(rowToInvestigation);
  }

  async archive(id: string): Promise<Investigation | undefined> {
    const [row] = await this.db
      .update(investigations)
      .set({ archived: true, updatedAt: new Date().toISOString() })
      .where(eq(investigations.id, id))
      .returning();
    return row ? rowToInvestigation(row) : undefined;
  }

  async restore(id: string): Promise<Investigation | undefined> {
    const [row] = await this.db
      .update(investigations)
      .set({ archived: false, updatedAt: new Date().toISOString() })
      .where(eq(investigations.id, id))
      .returning();
    return row ? rowToInvestigation(row) : undefined;
  }

  async findArchived(tenantId?: string): Promise<Investigation[]> {
    const conditions = [eq(investigations.archived, true)];
    if (tenantId) conditions.push(eq(investigations.tenantId, tenantId));
    const rows = await this.db
      .select()
      .from(investigations)
      .where(and(...conditions));
    return rows.map(rowToInvestigation);
  }

  getArchived(): Promise<Investigation[]> {
    return this.findArchived();
  }

  restoreFromArchive(id: string): Promise<Investigation | undefined> {
    return this.restore(id);
  }

  // — Follow-ups

  async addFollowUp(investigationId: string, question: string): Promise<FollowUpRecord> {
    const now = new Date().toISOString();
    const id = `fu_${randomUUID().slice(0, 8)}`;
    const [row] = await this.db
      .insert(investigationFollowUps)
      .values({ id, investigationId, question, createdAt: now })
      .returning();
    return { id: row!.id, investigationId: row!.investigationId, question: row!.question, createdAt: row!.createdAt };
  }

  async getFollowUps(investigationId: string): Promise<FollowUpRecord[]> {
    const rows = await this.db
      .select()
      .from(investigationFollowUps)
      .where(eq(investigationFollowUps.investigationId, investigationId));
    return rows.map((r) => ({ id: r.id, investigationId: r.investigationId, question: r.question, createdAt: r.createdAt }));
  }

  // — Feedback

  async addFeedback(investigationId: string, body: FeedbackBody): Promise<StoredFeedback> {
    const now = new Date().toISOString();
    const id = `fb_${randomUUID().slice(0, 8)}`;
    const [row] = await this.db
      .insert(investigationFeedback)
      .values({
        id,
        investigationId,
        helpful: body.helpful,
        comment: body.comment ?? null,
        rootCauseVerdict: body.rootCauseVerdict ?? null,
        hypothesisFeedbacks: body.hypothesisFeedbacks ?? null,
        actionFeedbacks: body.actionFeedbacks ?? null,
        createdAt: now,
      })
      .returning();
    return {
      id: row!.id,
      investigationId: row!.investigationId,
      helpful: row!.helpful,
      comment: row!.comment ?? undefined,
      rootCauseVerdict: row!.rootCauseVerdict as StoredFeedback['rootCauseVerdict'],
      hypothesisFeedbacks: row!.hypothesisFeedbacks as StoredFeedback['hypothesisFeedbacks'],
      actionFeedbacks: row!.actionFeedbacks as StoredFeedback['actionFeedbacks'],
      createdAt: row!.createdAt,
    };
  }

  // — Conclusions

  async getConclusion(id: string): Promise<ExplanationResult | undefined> {
    const [row] = await this.db
      .select()
      .from(investigationConclusions)
      .where(eq(investigationConclusions.investigationId, id));
    return row ? (row.conclusion as ExplanationResult) : undefined;
  }

  async setConclusion(id: string, conclusion: ExplanationResult): Promise<void> {
    // Upsert: try insert, on conflict update
    const existing = await this.db
      .select()
      .from(investigationConclusions)
      .where(eq(investigationConclusions.investigationId, id));
    if (existing.length > 0) {
      await this.db
        .update(investigationConclusions)
        .set({ conclusion: toJsonColumn(conclusion) })
        .where(eq(investigationConclusions.investigationId, id));
    } else {
      await this.db
        .insert(investigationConclusions)
        .values({ investigationId: id, conclusion: toJsonColumn(conclusion) });
    }
  }

  // — Orchestrator write-back

  async updateStatus(id: string, status: string): Promise<Investigation | undefined> {
    return this.update(id, { status: status as Investigation['status'] });
  }

  async updatePlan(id: string, plan: Investigation['plan']): Promise<Investigation | undefined> {
    return this.update(id, { plan });
  }

  async updateResult(id: string, result: {
    hypotheses: Investigation['hypotheses'];
    evidence: Investigation['evidence'];
    conclusion: ExplanationResult | null;
  }): Promise<Investigation | undefined> {
    const inv = await this.update(id, {
      hypotheses: result.hypotheses,
      evidence: result.evidence,
    });
    if (inv && result.conclusion) {
      await this.setConclusion(id, result.conclusion);
    }
    return inv;
  }
}

// =====================================================================
// W6 / T6.A2 — Investigation store → SQLite repository
//
// `InvestigationRepository` is the W6-pattern replacement for the
// in-memory `InvestigationStore` at
// `packages/data-layer/src/stores/investigation-store.ts`. It mirrors
// the W2 `InstanceConfigRepository` style: `sql` template literals, no
// Drizzle fluent builders, JSON columns handled with JSON.stringify /
// JSON.parse.
//
// The canonical interface lives in
// `packages/common/src/repositories/investigation/interfaces.ts`. It is
// NOT yet re-exported from the top-level `@agentic-obs/common` barrel
// (touching barrels is out of scope for Team A.2 — parent reconciles).
// Until that wiring lands, the interface is declared locally below so
// this file compiles. The shapes MUST be kept in sync with
// `common/src/repositories/investigation/interfaces.ts`.
//
// The older `SqliteInvestigationRepository` above is retained only
// because `packages/data-layer/src/repository/factory.ts` still imports
// it. The parent team will delete it after swapping the factory wiring.
// =====================================================================

/**
 * Creation params matching `InvestigationStore.create`. Kept identical
 * so the parent can swap the store for the repository without touching
 * call sites.
 */
export interface CreateInvestigationInput {
  question: string;
  sessionId: string;
  userId: string;
  entity?: string;
  timeRange?: { start: string; end: string };
  tenantId?: string;
  workspaceId?: string;
}

/** Payload for `updateResult`. */
export interface UpdateResultInput {
  hypotheses: Hypothesis[];
  evidence: Evidence[];
  conclusion: ExplanationResult | null;
}

/**
 * Local mirror of `IInvestigationRepository` from
 * `@agentic-obs/common/repositories/investigation/interfaces.ts`. Remove
 * this declaration and `implements`-reference the common export once the
 * parent wires the barrel.
 */
export interface IInvestigationRepositoryV6 {
  create(input: CreateInvestigationInput): Promise<Investigation>;
  findById(id: string): Promise<Investigation | null>;
  findAll(tenantId?: string): Promise<Investigation[]>;
  findByWorkspace(workspaceId: string): Promise<Investigation[]>;
  delete(id: string): Promise<boolean>;

  updateStatus(id: string, status: InvestigationStatus): Promise<Investigation | null>;
  updatePlan(id: string, plan: Investigation['plan']): Promise<Investigation | null>;
  updateResult(id: string, result: UpdateResultInput): Promise<Investigation | null>;

  archive(id: string): Promise<Investigation | null>;
  restoreFromArchive(id: string): Promise<Investigation | null>;
  getArchived(): Promise<Investigation[]>;

  addFollowUp(investigationId: string, question: string): Promise<FollowUpRecord>;
  getFollowUps(investigationId: string): Promise<FollowUpRecord[]>;

  addFeedback(investigationId: string, body: FeedbackBody): Promise<StoredFeedback>;
  listFeedback(investigationId: string): Promise<StoredFeedback[]>;

  getConclusion(id: string): Promise<ExplanationResult | null>;
  setConclusion(id: string, conclusion: ExplanationResult): Promise<void>;
}

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
export class InvestigationRepository implements IInvestigationRepositoryV6 {
  constructor(private readonly db: SqliteClient) {}

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

    this.db.run(sql`
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
    const rows = this.db.all<InvestigationRow>(
      sql`SELECT * FROM investigations WHERE id = ${id}`,
    );
    if (rows.length === 0) return null;
    return rowToInvestigationV6(rows[0]!);
  }

  async findAll(tenantId?: string): Promise<Investigation[]> {
    const rows =
      tenantId === undefined
        ? this.db.all<InvestigationRow>(sql`
            SELECT * FROM investigations
            WHERE archived = 0
            ORDER BY created_at DESC
          `)
        : this.db.all<InvestigationRow>(sql`
            SELECT * FROM investigations
            WHERE archived = 0 AND tenant_id = ${tenantId}
            ORDER BY created_at DESC
          `);
    return rows.map(rowToInvestigationV6);
  }

  async findByWorkspace(workspaceId: string): Promise<Investigation[]> {
    const rows = this.db.all<InvestigationRow>(sql`
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
    this.db.run(sql`DELETE FROM investigations WHERE id = ${id}`);
    return true;
  }

  // -- Write-backs

  async updateStatus(
    id: string,
    status: InvestigationStatus,
  ): Promise<Investigation | null> {
    const existing = await this.findById(id);
    if (!existing) return null;
    this.db.run(sql`
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
    this.db.run(sql`
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
    this.db.run(sql`
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
    const rows = this.db.all<{ id: string }>(
      sql`SELECT id FROM investigations WHERE id = ${id}`,
    );
    if (rows.length === 0) return null;
    this.db.run(sql`
      UPDATE investigations
      SET archived = 1, updated_at = ${nowIso()}
      WHERE id = ${id}
    `);
    const rowAfter = this.db.all<InvestigationRow>(
      sql`SELECT * FROM investigations WHERE id = ${id}`,
    );
    return rowAfter.length === 0 ? null : rowToInvestigationV6(rowAfter[0]!);
  }

  async restoreFromArchive(id: string): Promise<Investigation | null> {
    const rows = this.db.all<InvestigationRow>(
      sql`SELECT * FROM investigations WHERE id = ${id} AND archived = 1`,
    );
    if (rows.length === 0) return null;
    this.db.run(sql`
      UPDATE investigations
      SET archived = 0, updated_at = ${nowIso()}
      WHERE id = ${id}
    `);
    return this.findById(id);
  }

  async getArchived(): Promise<Investigation[]> {
    const rows = this.db.all<InvestigationRow>(sql`
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
    this.db.run(sql`
      INSERT INTO investigation_follow_ups (id, investigation_id, question, created_at)
      VALUES (${id}, ${investigationId}, ${question}, ${createdAt})
    `);
    return { id, investigationId, question, createdAt };
  }

  async getFollowUps(investigationId: string): Promise<FollowUpRecord[]> {
    const rows = this.db.all<FollowUpRow>(sql`
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
    this.db.run(sql`
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
    const rows = this.db.all<FeedbackRow>(sql`
      SELECT * FROM investigation_feedback
      WHERE investigation_id = ${investigationId}
      ORDER BY created_at ASC
    `);
    return rows.map(rowToFeedback);
  }

  // -- Conclusions

  async getConclusion(id: string): Promise<ExplanationResult | null> {
    const rows = this.db.all<ConclusionRow>(sql`
      SELECT * FROM investigation_conclusions WHERE investigation_id = ${id}
    `);
    if (rows.length === 0) return null;
    return parseJson<ExplanationResult | null>(rows[0]!.conclusion, null);
  }

  async setConclusion(id: string, conclusion: ExplanationResult): Promise<void> {
    this.db.run(sql`
      INSERT INTO investigation_conclusions (investigation_id, conclusion)
      VALUES (${id}, ${JSON.stringify(conclusion)})
      ON CONFLICT(investigation_id) DO UPDATE SET
        conclusion = excluded.conclusion
    `);
  }
}
