import { and, eq, inArray, or, sql } from 'drizzle-orm';
import { randomUUID } from 'crypto';
import { resourceServiceAttribution } from '../../db/schema.js';
import type {
  AttributionResourceKind,
  AttributionSourceKind,
  IServiceAttributionRepository,
  ServiceAttribution,
  ServiceSummary,
  UnassignedResourceRef,
} from '../interfaces.js';

type Row = typeof resourceServiceAttribution.$inferSelect;

function rowToAttribution(row: Row): ServiceAttribution {
  return {
    id: row.id,
    orgId: row.orgId,
    resourceKind: row.resourceKind as AttributionResourceKind,
    resourceId: row.resourceId,
    serviceName: row.serviceName,
    sourceTier: row.sourceTier as ServiceAttribution['sourceTier'],
    sourceKind: row.sourceKind as AttributionSourceKind,
    confidence: row.confidence,
    userConfirmed: Boolean(row.userConfirmed),
    createdAt: row.createdAt,
  };
}

/**
 * Postgres implementation of `IServiceAttributionRepository`. The
 * visibility threshold (`user_confirmed OR confidence >= 0.8`) is
 * enforced at read time, identical to the SQLite repo.
 */
export class PostgresServiceAttributionRepository
  implements IServiceAttributionRepository
{
  constructor(private readonly db: any) {}

  private visiblePredicate() {
    return or(
      eq(resourceServiceAttribution.userConfirmed, true),
      sql`${resourceServiceAttribution.confidence} >= 0.8`,
    );
  }

  async upsert(
    orgId: string,
    attribution: Omit<ServiceAttribution, 'id' | 'orgId' | 'createdAt'> & {
      id?: string;
      createdAt?: string;
    },
  ): Promise<ServiceAttribution> {
    const existing = await this.db
      .select()
      .from(resourceServiceAttribution)
      .where(
        and(
          eq(resourceServiceAttribution.orgId, orgId),
          eq(resourceServiceAttribution.resourceKind, attribution.resourceKind),
          eq(resourceServiceAttribution.resourceId, attribution.resourceId),
          eq(resourceServiceAttribution.sourceKind, attribution.sourceKind),
        ),
      );

    if (existing.length > 0) {
      const id = existing[0]!.id;
      const [updated] = await this.db
        .update(resourceServiceAttribution)
        .set({
          serviceName: attribution.serviceName,
          sourceTier: attribution.sourceTier,
          confidence: attribution.confidence,
          userConfirmed: attribution.userConfirmed,
        })
        .where(eq(resourceServiceAttribution.id, id))
        .returning();
      return rowToAttribution(updated!);
    }

    const [inserted] = await this.db
      .insert(resourceServiceAttribution)
      .values({
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
      })
      .returning();
    return rowToAttribution(inserted!);
  }

  async listAttributionsByResource(
    orgId: string,
    kind: AttributionResourceKind,
    id: string,
  ): Promise<ServiceAttribution[]> {
    const rows = await this.db
      .select()
      .from(resourceServiceAttribution)
      .where(
        and(
          eq(resourceServiceAttribution.orgId, orgId),
          eq(resourceServiceAttribution.resourceKind, kind),
          eq(resourceServiceAttribution.resourceId, id),
        ),
      );
    return rows.map(rowToAttribution);
  }

  async listServices(orgId: string): Promise<ServiceSummary[]> {
    const rows = await this.db
      .select()
      .from(resourceServiceAttribution)
      .where(
        and(eq(resourceServiceAttribution.orgId, orgId), this.visiblePredicate()),
      );
    const seen = new Set<string>();
    const counts = new Map<string, number>();
    for (const row of rows) {
      const r = rowToAttribution(row);
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
    const rows = await this.db
      .select()
      .from(resourceServiceAttribution)
      .where(
        and(
          eq(resourceServiceAttribution.orgId, orgId),
          eq(resourceServiceAttribution.serviceName, name),
          this.visiblePredicate(),
        ),
      );
    const seen = new Set<string>();
    const out: UnassignedResourceRef[] = [];
    for (const row of rows) {
      const r = rowToAttribution(row);
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
    if (candidateIds.length === 0) return [];
    const rows = await this.db
      .select({ resourceId: resourceServiceAttribution.resourceId })
      .from(resourceServiceAttribution)
      .where(
        and(
          eq(resourceServiceAttribution.orgId, orgId),
          eq(resourceServiceAttribution.resourceKind, kind),
          inArray(resourceServiceAttribution.resourceId, candidateIds),
          this.visiblePredicate(),
        ),
      );
    const attributed = new Set<string>(rows.map((r: any) => r.resourceId));
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
