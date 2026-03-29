// In-memory store for investigations, follow-ups, and feedback
import { markDirty } from '../../persistence.js';

function uid() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function emptyPlan(entity = '', objective = '') {
  return { entity, objective, steps: [], stopConditions: [] };
}

export class InvestigationStore {
  investigations = new Map();
  archivedItems = new Map();
  followUps = new Map();
  feedback = new Map();
  conclusions = new Map();
  maxCapacity;
  /** tenantId tag per investigation id */
  tenants = new Map();

  constructor(maxCapacity = 1000) {
    this.maxCapacity = maxCapacity;
  }

  // --- Investigations
  create(params) {
    const now = new Date().toISOString();
    const id = `inv_${uid()}`;
    const defaultTimeRange = params.timeRange ?? {
      start: new Date(Date.now() - 3600_000).toISOString(),
      end: now,
    };
    const investigation = {
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
      createdAt: now,
      updatedAt: now,
    };
    this.investigations.set(id, investigation);
    if (params.tenantId) {
      this.tenants.set(id, params.tenantId);
    }
    this._evictIfNeeded();
    markDirty();
    return investigation;
  }

  _evictIfNeeded() {
    if (this.investigations.size <= this.maxCapacity) {
      return;
    }
    let oldest;
    for (const inv of this.investigations.values()) {
      if (inv.status === 'completed' || inv.status === 'failed') {
        if (!oldest || inv.createdAt < oldest.createdAt) {
          oldest = inv;
        }
      }
    }
    if (oldest) {
      this.archivedItems.set(oldest.id, oldest);
      this.investigations.delete(oldest.id);
    }
  }

  findById(id) {
    return this.investigations.get(id) ?? this.archivedItems.get(id);
  }

  getArchived() {
    return [...this.archivedItems.values()];
  }

  restoreFromArchive(id) {
    const inv = this.archivedItems.get(id);
    if (!inv) {
      return undefined;
    }
    this.archivedItems.delete(id);
    this.investigations.set(id, inv);
    return inv;
  }

  findAll(tenantId) {
    const all = [...this.investigations.values()];
    if (tenantId === undefined) {
      return all;
    }
    return all.filter((inv) => this.tenants.get(inv.id) === tenantId);
  }

  updateStatus(id, status) {
    const inv = this.investigations.get(id);
    if (!inv) {
      return undefined;
    }
    const updated = { ...inv, status, updatedAt: new Date().toISOString() };
    this.investigations.set(id, updated);
    markDirty();
    return updated;
  }

  updatePlan(id, plan) {
    const inv = this.investigations.get(id);
    if (!inv) {
      return undefined;
    }
    const updated = { ...inv, plan, updatedAt: new Date().toISOString() };
    this.investigations.set(id, updated);
    markDirty();
    return updated;
  }

  updateResult(id, result) {
    const inv = this.investigations.get(id);
    if (!inv) {
      return undefined;
    }
    const updated = {
      ...inv,
      hypotheses: result.hypotheses,
      evidence: result.evidence,
      updatedAt: new Date().toISOString(),
    };
    this.investigations.set(id, updated);
    if (result.conclusion) {
      this.conclusions.set(id, result.conclusion);
    }
    markDirty();
    return updated;
  }

  getConclusion(id) {
    return this.conclusions.get(id);
  }

  // --- Follow-ups
  addFollowUp(investigationId, question) {
    const record = {
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

  getFollowUps(investigationId) {
    return this.followUps.get(investigationId) ?? [];
  }

  // --- Feedback
  addFeedback(investigationId, body) {
    const record = {
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

  // --- Utility
  get size() {
    return this.investigations.size;
  }

  clear() {
    this.investigations.clear();
    this.archivedItems.clear();
    this.followUps.clear();
    this.feedback.clear();
    this.conclusions.clear();
    this.tenants.clear();
  }

  toJSON() {
    const mapToObj = (m) => {
      const out = {};
      for (const [k, v] of m) {
        out[k] = v;
      }
      return out;
    };
    return {
      investigations: [...this.investigations.values()],
      archived: [...this.archivedItems.values()],
      followUps: mapToObj(this.followUps),
      feedback: mapToObj(this.feedback),
      tenants: mapToObj(this.tenants),
    };
  }

  loadJSON(data) {
    const d = data ?? {};
    if (Array.isArray(d.investigations)) {
      for (const inv of d.investigations) {
        if (inv.id) {
          this.investigations.set(inv.id, inv);
        }
      }
    }
    if (Array.isArray(d.archived)) {
      for (const inv of d.archived) {
        if (inv.id) {
          this.archivedItems.set(inv.id, inv);
        }
      }
    }
    if (d.followUps && typeof d.followUps === 'object') {
      for (const [k, v] of Object.entries(d.followUps)) {
        if (Array.isArray(v)) {
          this.followUps.set(k, v);
        }
      }
    }
    if (d.feedback && typeof d.feedback === 'object') {
      for (const [k, v] of Object.entries(d.feedback)) {
        if (Array.isArray(v)) {
          this.feedback.set(k, v);
        }
      }
    }
    if (d.tenants && typeof d.tenants === 'object') {
      for (const [k, v] of Object.entries(d.tenants)) {
        this.tenants.set(k, v);
      }
    }
  }
}

/** Module-level singleton - replace with DI in production */
export const defaultInvestigationStore = new InvestigationStore();
//# sourceMappingURL=store.js.map
