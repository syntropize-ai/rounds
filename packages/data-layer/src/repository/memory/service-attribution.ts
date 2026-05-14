import { randomUUID } from 'crypto';
import type {
  AttributionResourceKind,
  IServiceAttributionRepository,
  ServiceAttribution,
  ServiceSummary,
  UnassignedResourceRef,
} from '../interfaces.js';

/**
 * In-memory implementation of `IServiceAttributionRepository`. Test
 * fixture only — production uses SQLite or Postgres (ADR-001).
 */
export class InMemoryServiceAttributionRepository
  implements IServiceAttributionRepository
{
  private rows: ServiceAttribution[] = [];

  private visible(r: ServiceAttribution): boolean {
    return r.userConfirmed || r.confidence >= 0.8;
  }

  async upsert(
    orgId: string,
    attribution: Omit<ServiceAttribution, 'id' | 'orgId' | 'createdAt'> & {
      id?: string;
      createdAt?: string;
    },
  ): Promise<ServiceAttribution> {
    const existingIdx = this.rows.findIndex(
      (r) =>
        r.orgId === orgId &&
        r.resourceKind === attribution.resourceKind &&
        r.resourceId === attribution.resourceId &&
        r.sourceKind === attribution.sourceKind,
    );
    const row: ServiceAttribution = {
      id: attribution.id ?? randomUUID(),
      orgId,
      resourceKind: attribution.resourceKind,
      resourceId: attribution.resourceId,
      serviceName: attribution.serviceName,
      sourceTier: attribution.sourceTier,
      sourceKind: attribution.sourceKind,
      confidence: attribution.confidence,
      userConfirmed: attribution.userConfirmed,
      createdAt: attribution.createdAt ?? new Date().toISOString(),
    };
    if (existingIdx >= 0) {
      this.rows[existingIdx] = { ...row, id: this.rows[existingIdx]!.id };
      return this.rows[existingIdx]!;
    }
    this.rows.push(row);
    return row;
  }

  async listAttributionsByResource(
    orgId: string,
    kind: AttributionResourceKind,
    id: string,
  ): Promise<ServiceAttribution[]> {
    return this.rows.filter(
      (r) => r.orgId === orgId && r.resourceKind === kind && r.resourceId === id,
    );
  }

  async listServices(orgId: string): Promise<ServiceSummary[]> {
    const visible = this.rows.filter((r) => r.orgId === orgId && this.visible(r));
    // Dedup by (resource, service) — a resource attributed to "foo" by two
    // different sources still counts as one.
    const seen = new Set<string>();
    const counts = new Map<string, number>();
    for (const r of visible) {
      const key = `${r.resourceKind}::${r.resourceId}::${r.serviceName}`;
      if (seen.has(key)) continue;
      seen.add(key);
      counts.set(r.serviceName, (counts.get(r.serviceName) ?? 0) + 1);
    }
    return Array.from(counts.entries())
      .map(([name, resourceCount]) => ({ name, resourceCount }))
      .sort((a, b) => b.resourceCount - a.resourceCount);
  }

  async listResourcesForService(
    orgId: string,
    name: string,
  ): Promise<UnassignedResourceRef[]> {
    const seen = new Set<string>();
    const out: UnassignedResourceRef[] = [];
    for (const r of this.rows) {
      if (r.orgId !== orgId || r.serviceName !== name || !this.visible(r)) continue;
      const key = `${r.resourceKind}::${r.resourceId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ kind: r.resourceKind, id: r.resourceId });
    }
    return out;
  }

  async listUnassigned(
    orgId: string,
    kind: AttributionResourceKind,
    candidateIds: string[],
  ): Promise<string[]> {
    const attributed = new Set(
      this.rows
        .filter(
          (r) =>
            r.orgId === orgId && r.resourceKind === kind && this.visible(r),
        )
        .map((r) => r.resourceId),
    );
    return candidateIds.filter((id) => !attributed.has(id));
  }

  async confirmAttribution(
    orgId: string,
    kind: AttributionResourceKind,
    id: string,
    serviceName: string,
    _userId: string,
  ): Promise<ServiceAttribution> {
    return this.upsert(orgId, {
      resourceKind: kind,
      resourceId: id,
      serviceName,
      sourceTier: 4,
      sourceKind: 'manual',
      confidence: 1,
      userConfirmed: true,
    });
  }
}
