import type { ActionContext } from './_context.js';
import { withToolEventBoundary } from './_shared.js';

// ---------------------------------------------------------------------------
// Navigation — open an existing page in the UI
// ---------------------------------------------------------------------------

export async function handleNavigate(
  ctx: ActionContext,
  args: Record<string, unknown>,
): Promise<string> {
  const path = String(args.path ?? '');
  if (!path) return 'Error: "path" is required (e.g., "/dashboards/<id>", "/investigations/<id>", "/alerts").';
  if (!path.startsWith('/')) return 'Error: "path" must start with "/".';

  return withToolEventBoundary(
    ctx.sendEvent,
    'navigate',
    { path },
    `Opening ${path}`,
    async () => {
      ctx.setNavigateTo(path);
      return `Navigating to ${path}.`;
    },
  );
}
