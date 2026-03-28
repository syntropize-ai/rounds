// In-memory evidence store - append-only, queryable by hypothesis or investigation

import type { Evidence } from '@agentic-obs/common';

export class EvidenceStore {
  private readonly items = new Map<string, Evidence>();

  add(evidence: Evidence): void {
    this.items.set(evidence.id, evidence);
  }

  addAll(items: Evidence[]): void {
    for (const item of items) {
      this.items.set(item.id, item);
    }
  }

  get(id: string): Evidence | undefined {
    return this.items.get(id);
  }

  getByHypothesis(hypothesisId: string): Evidence[] {
    return [...this.items.values()].filter((e) => e.hypothesisId === hypothesisId);
  }

  getByIds(ids: string[]): Evidence[] {
    return ids.flatMap((id) => {
      const e = this.items.get(id);
      return e ? [e] : [];
    });
  }

  list(): Evidence[] {
    return [...this.items.values()];
  }

  get size(): number {
    return this.items.size;
  }

  clear(): void {
    this.items.clear();
  }
}
