// In-memory store for investigations, follow-ups, and feedback

import { randomUUID } from 'node:crypto';
import type { Investigation, InvestigationStatus, Hypothesis, Evidence } from '@agentic-obs/common';
import type { ExplanationResult } from '@agentic-obs/common';
import type { Persistable } from './persistence.js';
import { markDirty } from './persistence.js';

function uid(): string {
  return randomUUID();
}

function emptyPlan(entity = '', objective = ''): Investigation['plan'] {
  return { entity, objective, steps: [], stopConditions: [] };
}

// -- Types re-exported for consumers

import type {
  FollowUpRecord,
  FeedbackBody,
  StoredFeedback,
} from '../repository/types/investigation.js';

export type {
  FollowUpRecord,
  FeedbackBody,
  StoredFeedback,
} from '../repository/types/investigation.js';

export class InvestigationStore implements Persistable {
  private readonly investigations = new Map<string, Investigation>();
  private readonly archivedItems = new Map<string, Investigation>();
  private readonly followUps = new Map<string, FollowUpRecord[]>();
  private readonly feedback = new Map<string, StoredFeedback[]>();
  private readonly conclusions = new Map<string, ExplanationResult>();
  private readonly maxCapacity: number;
  private readonly tenants = new Map<string, string>();
  private readonly workspaces = new Map<string, string>();

  constructor(maxCapacity = 1000) {
    this.maxCapacity = maxCapacity;
  }

  // -- Investigations

  create(params: {
    question: string;
    sessionId: string;
    userId: string;
    entity?: string;
    timeRange?: { start: string; end: string };
    tenantId?: string;
    workspaceId?: string;
  }): Investigation {
    const now = new Date().toISOString();
    const id = `inv_${uid()}`;
    const defaultTimeRange = params.timeRange ?? {
      start: new Date(Date.now() - 3600_000).toISOString(),
      end: now,
    };

    const investigation: Investigation = {
      id,
      sessionId: params.sessionId,
      userId: params.userId,
      intent: params.question,
      structuredIntent: {
        taskType: 'general_query',
        entity: params.entity ?? '',
        timeRange: defaultTimeRange,
        goal: params.question,
      },
      plan: emptyPlan(params.entity ?? '', params.question),
      status: 'planning',
      hypotheses: [],
      actions: [],
      evidence: [],
      symptoms: [],
      ...(params.workspaceId ? { workspaceId: params.workspaceId } : {}),
      createdAt: now,
      updatedAt: now,
    };

    this.investigations.set(id, investigation);
    if (params.tenantId)
      this.tenants.set(id, params.tenantId);
    if (params.workspaceId)
      this.workspaces.set(id, params.workspaceId);
    this.evictIfNeeded();
    markDirty();
    return investigation;
  }

  private evictIfNeeded(): void {
    if (this.investigations.size <= this.maxCapacity)
      return;

    let oldest: Investigation | undefined;
    for (const inv of this.investigations.values()) {
      if (inv.status !== 'completed' && inv.status !== 'failed') {
        if (!oldest || inv.createdAt < oldest.createdAt)
          oldest = inv;
      }
    }

    if (oldest) {
      this.archivedItems.set(oldest.id, oldest);
      this.investigations.delete(oldest.id);
    }
  }

  findById(id: string): Investigation | undefined {
    return this.investigations.get(id) ?? this.archivedItems.get(id);
  }

  getArchived(): Investigation[] {
    return [...this.archivedItems.values()];
  }

  restoreFromArchive(id: string): Investigation | undefined {
    const inv = this.archivedItems.get(id);
    if (!inv)
      return undefined;
    this.archivedItems.delete(id);
    this.investigations.set(id, inv);
    return inv;
  }

  restoreFromArchiveInWorkspace(id: string, workspaceId: string): Investigation | undefined {
    const inv = this.archivedItems.get(id);
    if (!inv || inv.workspaceId !== workspaceId)
      return undefined;
    this.archivedItems.delete(id);
    this.investigations.set(id, inv);
    return inv;
  }

  findAll(tenantId?: string): Investigation[] {
    const all = [...this.investigations.values()];
    if (tenantId === undefined)
      return all;
    return all.filter((inv) => this.tenants.get(inv.id) === tenantId);
  }

  findByWorkspace(workspaceId: string): Investigation[] {
    return [...this.investigations.values()].filter(
      (inv) => this.workspaces.get(inv.id) === workspaceId,
    );
  }

  getWorkspaceId(id: string): string | undefined {
    return this.workspaces.get(id);
  }

  updateStatus(id: string, status: InvestigationStatus): Investigation | undefined {
    const inv = this.investigations.get(id);
    if (!inv)
      return undefined;
    const updated = { ...inv, status, updatedAt: new Date().toISOString() };
    this.investigations.set(id, updated);
    markDirty();
    return updated;
  }

  updatePlan(id: string, plan: Investigation['plan']): Investigation | undefined {
    const inv = this.investigations.get(id);
    if (!inv)
      return undefined;
    const updated = { ...inv, plan, updatedAt: new Date().toISOString() };
    this.investigations.set(id, updated);
    markDirty();
    return updated;
  }

  updateResult(
    id: string,
    result: { hypotheses: Hypothesis[]; evidence: Evidence[]; conclusion: ExplanationResult | null },
  ): Investigation | undefined {
    const inv = this.investigations.get(id);
    if (!inv)
      return undefined;
    const updated = {
      ...inv,
      hypotheses: result.hypotheses,
      evidence: result.evidence,
      updatedAt: new Date().toISOString(),
    };
    this.investigations.set(id, updated);
    if (result.conclusion)
      this.conclusions.set(id, result.conclusion);
    markDirty();
    return updated;
  }

  getConclusion(id: string): ExplanationResult | undefined {
    return this.conclusions.get(id);
  }

  // -- Follow-ups

  addFollowUp(investigationId: string, question: string): FollowUpRecord {
    const record: FollowUpRecord = {
      id: `fu_${uid()}`,
      investigationId,
      question,
      createdAt: new Date().toISOString(),
    };

    const existing = this.followUps.get(investigationId) ?? [];
    existing.push(record);
    this.followUps.set(investigationId, existing);
    markDirty();
    return record;
  }

  getFollowUps(investigationId: string): FollowUpRecord[] {
    return this.followUps.get(investigationId) ?? [];
  }

  // -- Feedback

  addFeedback(investigationId: string, body: FeedbackBody): StoredFeedback {
    const record: StoredFeedback = {
      id: `fb_${uid()}`,
      investigationId,
      ...body,
      createdAt: new Date().toISOString(),
    };

    const existing = this.feedback.get(investigationId) ?? [];
    existing.push(record);
    this.feedback.set(investigationId, existing);
    markDirty();
    return record;
  }

  // -- Delete

  delete(id: string): boolean {
    const deleted = this.investigations.delete(id) || this.archivedItems.delete(id);
    if (deleted) {
      this.followUps.delete(id);
      this.feedback.delete(id);
      this.conclusions.delete(id);
      this.tenants.delete(id);
      this.workspaces.delete(id);
      markDirty();
    }
    return deleted;
  }

  // -- Utility

  get size(): number {
    return this.investigations.size;
  }

  clear(): void {
    this.investigations.clear();
    this.archivedItems.clear();
    this.followUps.clear();
    this.feedback.clear();
    this.conclusions.clear();
    this.tenants.clear();
    this.workspaces.clear();
  }

  toJSON(): unknown {
    const mapToObj = <V>(m: Map<string, V>) => {
      const o: Record<string, V> = {};
      for (const [k, v] of m)
        o[k] = v;
      return o;
    };

    return {
      investigations: [...this.investigations.values()],
      archived: [...this.archivedItems.values()],
      followUps: mapToObj(this.followUps),
      feedback: mapToObj(this.feedback),
      tenants: mapToObj(this.tenants),
      workspaces: mapToObj(this.workspaces),
    };
  }

  loadJSON(data: unknown): void {
    const d = data as Record<string, unknown>;

    if (Array.isArray(d.investigations)) {
      for (const inv of d.investigations as Investigation[]) {
        if (inv.id)
          this.investigations.set(inv.id, inv);
      }
    }

    if (Array.isArray(d.archived)) {
      for (const inv of d.archived as Investigation[]) {
        if (inv.id)
          this.archivedItems.set(inv.id, inv);
      }
    }

    if (d.followUps && typeof d.followUps === 'object') {
      for (const [k, v] of Object.entries(d.followUps as Record<string, FollowUpRecord[]>)) {
        if (Array.isArray(v))
          this.followUps.set(k, v);
      }
    }

    if (d.feedback && typeof d.feedback === 'object') {
      for (const [k, v] of Object.entries(d.feedback as Record<string, StoredFeedback[]>)) {
        if (Array.isArray(v))
          this.feedback.set(k, v);
      }
    }

    if (d.tenants && typeof d.tenants === 'object') {
      for (const [k, v] of Object.entries(d.tenants as Record<string, string>)) {
        this.tenants.set(k, v);
      }
    }

    if (d.workspaces && typeof d.workspaces === 'object') {
      for (const [k, v] of Object.entries(d.workspaces as Record<string, string>)) {
        this.workspaces.set(k, v);
      }
    }
  }
}

// Module-level singleton - replace with DI in production
export const defaultInvestigationStore = new InvestigationStore();
