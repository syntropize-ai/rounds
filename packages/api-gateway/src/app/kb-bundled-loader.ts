/**
 * Idempotently seed the bundled (factory-shipped) knowledge-base entries for
 * an org. Called once per known org at boot — re-runs are a no-op once the
 * seeds exist (matched by id).
 *
 * Insert failures are logged but do NOT abort the loop; the next boot will
 * retry the missing seed.
 */

import { BUNDLED_SEEDS, type IKnowledgeRepository } from '@agentic-obs/common';
import { createLogger } from '@agentic-obs/server-utils/logging';

const log = createLogger('kb-bundled-loader');

export async function ensureBundledSeeds(
  repo: IKnowledgeRepository,
  orgId: string,
): Promise<{ inserted: number; skipped: number }> {
  let inserted = 0;
  let skipped = 0;
  for (const seed of BUNDLED_SEEDS) {
    try {
      const existing = await repo.getById(orgId, seed.id);
      if (existing) {
        skipped++;
        continue;
      }
      await repo.insert({ ...seed, orgId });
      inserted++;
    } catch (err) {
      log.error(
        { id: seed.id, err: err instanceof Error ? err.message : err },
        'failed to insert bundled KB seed',
      );
    }
  }
  log.info({ orgId, inserted, skipped }, 'bundled KB seeds loaded');
  return { inserted, skipped };
}
