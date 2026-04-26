import type { ActionContext } from './_context.js';
import type { SignalType } from '../../adapters/index.js';

// ---------------------------------------------------------------------------
// Datasource discovery (always allowed — required before metrics/logs/changes)
// ---------------------------------------------------------------------------

// TODO: migrate to withToolEventBoundary
export async function handleDatasourcesList(
  ctx: ActionContext,
  args: Record<string, unknown>,
): Promise<string> {
  const signalType = typeof args.signalType === 'string' ? args.signalType : undefined;
  const filter: { signalType?: SignalType } | undefined =
    signalType === 'metrics' || signalType === 'logs' || signalType === 'changes'
      ? { signalType }
      : undefined;
  ctx.sendEvent({
    type: 'tool_call',
    tool: 'datasources.list',
    args: filter ? filter : {},
    displayText: filter ? `Listing ${filter.signalType} datasources` : 'Listing datasources',
  });

  const infos = ctx.adapters.list(filter);
  if (infos.length === 0) {
    const msg = filter
      ? `No ${filter.signalType} datasources are configured.`
      : 'No datasources are configured.';
    ctx.sendEvent({ type: 'tool_result', tool: 'datasources.list', summary: msg, success: true });
    return msg;
  }
  const lines = infos.map((d) => {
    const tail = d.isDefault ? ' — default' : '';
    return `id: ${d.id} (${d.type}, ${d.signalType})${tail}`;
  });
  const summary = lines.join('\n');
  ctx.sendEvent({
    type: 'tool_result',
    tool: 'datasources.list',
    summary: `${infos.length} datasource(s)`,
    success: true,
  });
  return summary;
}
