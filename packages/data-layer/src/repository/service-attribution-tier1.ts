/**
 * Tier-1 service-name extraction (Wave 2 / Step 2).
 *
 * Tier 1 = high-confidence (`0.95`) automatic attribution from signals
 * already attached to a resource at create time:
 *   - Prometheus `service="..."` label in a PromQL expression
 *   - GitHub repo name from a normalized change-event
 *
 * Higher tiers (k8s reconciler, AI inference) are deferred.
 */

import type {
  IServiceAttributionRepository,
  AttributionResourceKind,
} from './interfaces.js';

/**
 * Extract the `service` label value from a PromQL expression. Matches
 * the common label-matcher syntax `service="foo"` (allowing `==`, single
 * quotes, and surrounding whitespace). Returns the first match.
 *
 * The regex deliberately allows only `=` and `==` (equality matchers) —
 * a regex matcher (`service=~"..."`) is too ambiguous to attribute
 * automatically and is left to Tier 3 (AI infer).
 */
export function extractPromqlServiceLabel(promql: string): string | null {
  if (!promql) return null;
  // service ("=" | "==") (whitespace) ("..." | '...')
  const match = promql.match(
    /\bservice\s*={1,2}\s*(?:"([^"]+)"|'([^']+)')/,
  );
  if (!match) return null;
  return match[1] ?? match[2] ?? null;
}

/**
 * Extract a service name from a set of PromQL expressions. Returns the
 * first value found across all queries (consistent label values across
 * a single dashboard/rule are the common case; mixed is rare and we
 * surface only the first to avoid silently dropping signal).
 */
export function extractServiceFromQueries(queries: string[]): string | null {
  for (const q of queries) {
    const v = extractPromqlServiceLabel(q);
    if (v) return v;
  }
  return null;
}

/**
 * Apply Tier-1 auto-attribution to a resource. Best-effort: if extraction
 * yields no service, returns false and writes nothing. Failures are
 * swallowed and reported so the caller's primary write isn't blocked.
 */
export async function applyTier1PromqlAttribution(
  repo: IServiceAttributionRepository,
  orgId: string,
  resource: { kind: AttributionResourceKind; id: string; queries: string[] },
): Promise<{ attributed: boolean; service?: string }> {
  const service = extractServiceFromQueries(resource.queries);
  if (!service) return { attributed: false };
  try {
    await repo.upsert(orgId, {
      resourceKind: resource.kind,
      resourceId: resource.id,
      serviceName: service,
      sourceTier: 1,
      sourceKind: 'prom_label',
      confidence: 0.95,
      userConfirmed: false,
    });
    return { attributed: true, service };
  } catch {
    // Auto-fill must never block resource creation — surface false on failure.
    return { attributed: false };
  }
}

/**
 * Apply Tier-1 attribution from a GitHub change-event repo name. Used when
 * an investigation is created from a normalized change-event whose
 * `serviceId` is the full repo name (see
 * packages/adapters/src/change-event/normalizer.ts).
 */
export async function applyTier1GithubRepoAttribution(
  repo: IServiceAttributionRepository,
  orgId: string,
  resource: { kind: AttributionResourceKind; id: string; repoName: string },
): Promise<void> {
  if (!resource.repoName) return;
  try {
    await repo.upsert(orgId, {
      resourceKind: resource.kind,
      resourceId: resource.id,
      serviceName: resource.repoName,
      sourceTier: 1,
      sourceKind: 'github_repo',
      confidence: 0.95,
      userConfirmed: false,
    });
  } catch {
    // Swallow: attribution is auxiliary.
  }
}
