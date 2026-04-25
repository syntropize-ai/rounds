import { eq, isNull, isNotNull, and, sql } from 'drizzle-orm';
import { randomUUID } from 'crypto';
import type { Investigation } from '@agentic-obs/common';
import type { ExplanationResult } from '@agentic-obs/common';
import type { DbClient } from '../../db/client.js';
import { toJsonColumn } from '../json-column.js';
import { investigations } from '../../db/schema.js';
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
    actions: [],
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
        evidence: data.evidence,
        symptoms: data.symptoms,
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

  async findByWorkspace(_workspaceId: string): Promise<Investigation[]> {
    // Postgres schema does not have a workspaceId column — stub for interface compliance
    return [];
  }

  async addFollowUp(investigationId: string, question: string): Promise<FollowUpRecord> {
    // Postgres does not have a follow-ups table yet — store in-memory for now
    return {
      id: `fu_${randomUUID().slice(0, 8)}`,
      investigationId,
      question,
      createdAt: new Date().toISOString(),
    };
  }

  async getFollowUps(_investigationId: string): Promise<FollowUpRecord[]> {
    return [];
  }

  async addFeedback(investigationId: string, body: FeedbackBody): Promise<StoredFeedback> {
    return {
      id: `fb_${randomUUID().slice(0, 8)}`,
      investigationId,
      ...body,
      createdAt: new Date().toISOString(),
    };
  }

  async getConclusion(_id: string): Promise<ExplanationResult | undefined> {
    return undefined;
  }

  async setConclusion(_id: string, _conclusion: ExplanationResult): Promise<void> {
    // no-op for Postgres stub
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
    return this.update(id, {
      hypotheses: result.hypotheses,
      evidence: result.evidence,
    } as Partial<Omit<Investigation, 'id'>>);
  }
}
