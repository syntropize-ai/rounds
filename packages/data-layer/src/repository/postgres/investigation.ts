import { eq, isNull, isNotNull, and, asc, sql } from 'drizzle-orm';
import { randomUUID } from 'crypto';
import type { Investigation } from '@agentic-obs/common';
import type { ExplanationResult } from '@agentic-obs/common';
import type { DbClient } from '../../db/client.js';
import { toJsonColumn } from '../json-column.js';
import {
  investigations,
  investigationFollowUps,
  investigationFeedback,
  investigationConclusions,
} from '../../db/schema.js';
import type {
  IInvestigationRepository,
  InvestigationFindAllOptions,
} from '../interfaces.js';
import type { FollowUpRecord, FeedbackBody, StoredFeedback } from '../types/investigation.js';

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
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export class PostgresInvestigationRepository implements IInvestigationRepository {
  constructor(private readonly db: DbClient) {}

  async findById(id: string): Promise<Investigation | undefined> {
    const [row] = await this.db.select().from(investigations).where(eq(investigations.id, id));
    return row ? rowToInvestigation(row) : undefined;
  }

  async findAll(opts: InvestigationFindAllOptions = {}): Promise<Investigation[]> {
    const conditions = [isNull(investigations.archivedAt)];
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
    data: Omit<Investigation, 'id' | 'createdAt'> & { id?: string },
  ): Promise<Investigation> {
    const now = new Date();
    const id = data.id ?? `inv_${randomUUID().slice(0, 8)}`;
    const [row] = await this.db
      .insert(investigations)
      .values({
        id,
        tenantId: (data as Investigation & { tenantId?: string }).tenantId ?? 'default',
        sessionId: data.sessionId,
        userId: data.userId,
        intent: data.intent,
        structuredIntent: toJsonColumn(data.structuredIntent),
        plan: toJsonColumn(data.plan),
        status: data.status,
        hypotheses: data.hypotheses,
        actions: data.actions ?? [],
        evidence: data.evidence,
        symptoms: data.symptoms,
        workspaceId: data.workspaceId,
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
    const [row] = await this.db
      .update(investigations)
      .set({
        ...(patch.status !== undefined ? { status: patch.status } : {}),
        ...(patch.plan !== undefined ? { plan: toJsonColumn(patch.plan) } : {}),
        ...(patch.hypotheses !== undefined ? { hypotheses: patch.hypotheses } : {}),
        ...(patch.evidence !== undefined ? { evidence: patch.evidence } : {}),
        ...(patch.symptoms !== undefined ? { symptoms: patch.symptoms } : {}),
        ...(patch.actions !== undefined ? { actions: patch.actions } : {}),
        ...(patch.intent !== undefined ? { intent: patch.intent } : {}),
        updatedAt: new Date(),
      })
      .where(eq(investigations.id, id))
      .returning();

    return row ? rowToInvestigation(row) : undefined;
  }

  async delete(id: string): Promise<boolean> {
    const result = await this.db.delete(investigations).where(eq(investigations.id, id));
    return (result.rowCount ?? 0) > 0;
  }

  async count(): Promise<number> {
    const result = await this.db
      .select({ count: sql<number>`count(*)` })
      .from(investigations)
      .where(isNull(investigations.archivedAt));
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
    const conditions = [eq(investigations.userId, userId), isNull(investigations.archivedAt)];
    if (tenantId) conditions.push(eq(investigations.tenantId, tenantId));
    const rows = await this.db
      .select()
      .from(investigations)
      .where(and(...conditions));
    return rows.map(rowToInvestigation);
  }

  async archive(id: string): Promise<Investigation | undefined> {
    const [row] = await this.db
      .update(investigations)
      .set({ archivedAt: new Date(), updatedAt: new Date() })
      .where(eq(investigations.id, id))
      .returning();
    return row ? rowToInvestigation(row) : undefined;
  }

  async restore(id: string): Promise<Investigation | undefined> {
    const [row] = await this.db
      .update(investigations)
      .set({ archivedAt: null, updatedAt: new Date() })
      .where(eq(investigations.id, id))
      .returning();
    return row ? rowToInvestigation(row) : undefined;
  }

  async findArchived(tenantId?: string): Promise<Investigation[]> {
    const conditions = [isNotNull(investigations.archivedAt)];
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
      .where(
        and(eq(investigations.workspaceId, workspaceId), isNull(investigations.archivedAt)),
      );
    return rows.map(rowToInvestigation);
  }

  // — Follow-ups

  async addFollowUp(investigationId: string, question: string): Promise<FollowUpRecord> {
    const id = `fu_${randomUUID().slice(0, 8)}`;
    const [row] = await this.db
      .insert(investigationFollowUps)
      .values({ id, investigationId, question, createdAt: new Date() })
      .returning();
    return {
      id: row!.id,
      investigationId: row!.investigationId,
      question: row!.question,
      createdAt: row!.createdAt.toISOString(),
    };
  }

  async getFollowUps(investigationId: string): Promise<FollowUpRecord[]> {
    const rows = await this.db
      .select()
      .from(investigationFollowUps)
      .where(eq(investigationFollowUps.investigationId, investigationId))
      .orderBy(asc(investigationFollowUps.createdAt));
    return rows.map((r) => ({
      id: r.id,
      investigationId: r.investigationId,
      question: r.question,
      createdAt: r.createdAt.toISOString(),
    }));
  }

  // — Feedback

  async addFeedback(investigationId: string, body: FeedbackBody): Promise<StoredFeedback> {
    const id = `fb_${randomUUID().slice(0, 8)}`;
    const [row] = await this.db
      .insert(investigationFeedback)
      .values({
        id,
        investigationId,
        helpful: body.helpful,
        comment: body.comment ?? null,
        rootCauseVerdict: body.rootCauseVerdict ?? null,
        hypothesisFeedbacks: body.hypothesisFeedbacks
          ? toJsonColumn(body.hypothesisFeedbacks)
          : null,
        actionFeedbacks: body.actionFeedbacks ? toJsonColumn(body.actionFeedbacks) : null,
        createdAt: new Date(),
      })
      .returning();
    const saved: StoredFeedback = {
      id: row!.id,
      investigationId: row!.investigationId,
      helpful: row!.helpful,
      createdAt: row!.createdAt.toISOString(),
    };
    if (row!.comment !== null) saved.comment = row!.comment;
    if (row!.rootCauseVerdict !== null) {
      saved.rootCauseVerdict = row!.rootCauseVerdict as StoredFeedback['rootCauseVerdict'];
    }
    if (row!.hypothesisFeedbacks !== null) {
      saved.hypothesisFeedbacks = row!.hypothesisFeedbacks as StoredFeedback['hypothesisFeedbacks'];
    }
    if (row!.actionFeedbacks !== null) {
      saved.actionFeedbacks = row!.actionFeedbacks as StoredFeedback['actionFeedbacks'];
    }
    return saved;
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
    await this.db
      .insert(investigationConclusions)
      .values({ investigationId: id, conclusion: toJsonColumn(conclusion) })
      .onConflictDoUpdate({
        target: investigationConclusions.investigationId,
        set: { conclusion: toJsonColumn(conclusion) },
      });
  }

  async updateStatus(id: string, status: string): Promise<Investigation | undefined> {
    return this.update(id, { status } as Partial<Omit<Investigation, 'id'>>);
  }

  async updatePlan(id: string, plan: Investigation['plan']): Promise<Investigation | undefined> {
    return this.update(id, { plan } as Partial<Omit<Investigation, 'id'>>);
  }

  async updateResult(id: string, result: {
    hypotheses: Investigation['hypotheses'];
    evidence: Investigation['evidence'];
    conclusion: ExplanationResult | null;
  }): Promise<Investigation | undefined> {
    const inv = await this.update(id, {
      hypotheses: result.hypotheses,
      evidence: result.evidence,
    } as Partial<Omit<Investigation, 'id'>>);
    if (inv && result.conclusion) {
      await this.setConclusion(id, result.conclusion);
    }
    return inv;
  }
}
