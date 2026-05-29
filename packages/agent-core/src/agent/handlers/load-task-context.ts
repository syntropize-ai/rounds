import type { ActionContext } from './_context.js';
import { withToolEventBoundary } from './_shared.js';
import { getTaskModule, type TaskMode } from '../orchestrator-prompt.js';

const TASK_MODES: ReadonlySet<TaskMode> = new Set([
  'dashboard_build',
  'investigate',
  'alert_author',
  'ad_hoc_explore',
  'ops_command',
]);

/**
 * load_task_context — the agent self-invokes this once it has picked a task
 * shape from the decision flow. It returns the matching task module: the
 * detailed playbook (examples, query patterns, panel-correctness rules) that
 * the base prompt deliberately leaves out so the static prefix stays small.
 *
 * No backend resource is touched; the observation IS the agent's own guidance.
 */
export async function handleLoadTaskContext(
  ctx: ActionContext,
  args: Record<string, unknown>,
): Promise<string> {
  const mode = String(args.mode ?? '');
  if (!TASK_MODES.has(mode as TaskMode)) {
    return `Error: load_task_context requires "mode" (one of: ${[...TASK_MODES].join(', ')}). Received: "${mode || '(empty)'}".`;
  }
  return withToolEventBoundary(
    ctx.sendEvent,
    'load_task_context',
    { mode },
    `Loading ${mode} task context`,
    async () => ({
      observation: getTaskModule(mode as TaskMode),
      summary: `Loaded ${mode} task context`,
    }),
  );
}
