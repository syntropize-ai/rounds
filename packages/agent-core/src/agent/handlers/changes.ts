import type { ActionContext } from './_context.js';

// ---------------------------------------------------------------------------
// Recent change events — deploys / config rollouts / incidents / feature flags
// ---------------------------------------------------------------------------

// TODO: migrate to withToolEventBoundary
export async function handleChangesListRecent(
  ctx: ActionContext,
  args: Record<string, unknown>,
): Promise<string> {
  const explicitSource = typeof args.sourceId === 'string' && args.sourceId ? args.sourceId : undefined;
  let sourceId = explicitSource;
  if (!sourceId) {
    const firstChange = ctx.adapters.list({ signalType: 'changes' })[0];
    sourceId = firstChange?.id;
  }
  if (!sourceId) {
    const msg = 'No change-event datasource configured. Call datasources_list to see available sources.';
    ctx.sendEvent({ type: 'tool_result', tool: 'changes_list_recent', summary: msg, success: false });
    return msg;
  }
  const adapter = ctx.adapters.changes(sourceId);
  if (!adapter) {
    const msg = `Error: unknown changes datasource '${sourceId}'. Call datasources_list to see available sources.`;
    ctx.sendEvent({ type: 'tool_result', tool: 'changes_list_recent', summary: msg, success: false });
    return msg;
  }

  const service = typeof args.service === 'string' && args.service ? args.service : undefined;
  const windowMinutes = typeof args.window_minutes === 'number'
    ? args.window_minutes
    : typeof args.windowMinutes === 'number' ? args.windowMinutes : 60;

  ctx.sendEvent({
    type: 'tool_call',
    tool: 'changes_list_recent',
    args: { sourceId, service, window_minutes: windowMinutes },
    displayText: service ? `Recent changes for ${service} (last ${windowMinutes}m)` : `Recent changes (last ${windowMinutes}m)`,
  });

  try {
    const records = await adapter.listRecent({
      windowMinutes,
      ...(service ? { service } : {}),
    });
    if (records.length === 0) {
      const msg = service
        ? `No changes for ${service} in the last ${windowMinutes} minute(s).`
        : `No changes in the last ${windowMinutes} minute(s).`;
      ctx.sendEvent({ type: 'tool_result', tool: 'changes_list_recent', summary: msg, success: true });
      return msg;
    }
    const bullets = records.slice(0, 30).map((r) =>
      `- [${r.at}] ${r.service} (${r.kind}): ${r.summary}`,
    );
    const summary = `${records.length} change(s)${service ? ` for ${service}` : ''} in last ${windowMinutes}m:\n${bullets.join('\n')}${records.length > 30 ? `\n... and ${records.length - 30} more` : ''}`;
    ctx.sendEvent({ type: 'tool_result', tool: 'changes_list_recent', summary: `${records.length} changes`, success: true });
    return summary;
  } catch (err) {
    const msg = `Failed to list recent changes: ${err instanceof Error ? err.message : String(err)}`;
    ctx.sendEvent({ type: 'tool_result', tool: 'changes_list_recent', summary: msg, success: false });
    return msg;
  }
}
