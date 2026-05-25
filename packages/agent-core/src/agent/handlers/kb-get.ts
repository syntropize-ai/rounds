/**
 * `kb_get` — fetch a single KB entry by id. Bumps `useCount` so the repo can
 * surface popular entries elsewhere.
 */

import type { ActionContext } from './_context.js';
import { withToolEventBoundary } from './_shared.js';

export async function handleKbGet(
  ctx: ActionContext,
  args: Record<string, unknown>,
): Promise<string> {
  const id = typeof args['id'] === 'string' ? args['id'].trim() : '';
  if (!id) return 'Error: "id" is required.';

  if (!ctx.knowledge) {
    return 'Knowledge base is not configured for this workspace.';
  }
  const repo = ctx.knowledge;

  return withToolEventBoundary(
    ctx.sendEvent,
    'kb_get',
    { id },
    `Fetching KB entry ${id}`,
    async () => {
      const entry = await repo.getById(ctx.identity.orgId, id);
      if (!entry) {
        return `KB entry "${id}" not found.`;
      }
      ctx.dashboardBuildEvidence.kbConsultCount += 1;
      // Fire-and-forget — counter bookkeeping should not break the handler.
      void repo.bumpUseCount(ctx.identity.orgId, id).catch(() => undefined);
      return JSON.stringify({ entry });
    },
  );
}
