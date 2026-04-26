import { ac } from '@agentic-obs/common';
import type { GrafanaFolder } from '@agentic-obs/common';
import type { ActionContext } from './_context.js';

// ---------------------------------------------------------------------------
// Folder lifecycle (minimal — full UI flow lives in /api/folders; agent tools
// cover the create/list cases the orchestrator needs when asked to organize
// dashboards). Permission gate already validated access.
// ---------------------------------------------------------------------------

// TODO: migrate to withToolEventBoundary
export async function handleFolderCreate(
  ctx: ActionContext,
  args: Record<string, unknown>,
): Promise<string> {
  if (!ctx.folderRepository) return 'Error: folder backend not configured on this deployment.';
  const title = String(args.title ?? '').trim();
  if (!title) return 'Error: "title" is required.';
  const parentUid = typeof args.parentUid === 'string' && args.parentUid !== '' ? args.parentUid : null;

  ctx.sendEvent({ type: 'tool_call', tool: 'folder.create', args: { title, parentUid }, displayText: `Creating folder: ${title}` });

  // Simple uid slug from title; fall back to random if slug collides.
  const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || `folder-${Date.now().toString(36)}`;
  let uid = slug;
  if (await ctx.folderRepository.findByUid(ctx.identity.orgId, uid)) {
    uid = `${slug}-${Math.random().toString(36).slice(2, 6)}`;
  }

  const folder = await ctx.folderRepository.create({
    uid,
    orgId: ctx.identity.orgId,
    title,
    parentUid,
    createdBy: ctx.identity.userId,
    updatedBy: ctx.identity.userId,
  });

  const observation = `Folder "${folder.title}" created (uid=${folder.uid})${folder.parentUid ? ` under ${folder.parentUid}` : ' at root'}.`;
  ctx.sendEvent({ type: 'tool_result', tool: 'folder.create', summary: observation, success: true });
  ctx.emitAgentEvent(ctx.makeAgentEvent('agent.tool_completed', { tool: 'folder.create', folderUid: folder.uid }));
  return observation;
}

// TODO: migrate to withToolEventBoundary
export async function handleFolderList(
  ctx: ActionContext,
  args: Record<string, unknown>,
): Promise<string> {
  if (!ctx.folderRepository) return 'Error: folder backend not configured on this deployment.';
  const parentUid = typeof args.parentUid === 'string' ? args.parentUid : null;
  const limit = Math.min(Number(args.limit ?? 50), 200);

  ctx.sendEvent({ type: 'tool_call', tool: 'folder.list', args: { parentUid, limit }, displayText: 'Listing folders' });

  const page = await ctx.folderRepository.list({
    orgId: ctx.identity.orgId,
    parentUid,
    limit,
  });

  // Per-row filter: only return folders the identity can read (see §D12).
  const visible = await ctx.accessControl.filterByPermission(
    ctx.identity,
    page.items,
    (f: GrafanaFolder) => ac.eval('folders:read', `folders:uid:${f.uid}`),
  );

  if (visible.length === 0) {
    const msg = 'No folders visible to you' + (parentUid ? ` under ${parentUid}.` : '.');
    ctx.sendEvent({ type: 'tool_result', tool: 'folder.list', summary: msg, success: true });
    return msg;
  }
  const rows = visible
    .slice(0, 20)
    .map((f) => `- ${f.title} (uid=${f.uid})${f.parentUid ? `, parent=${f.parentUid}` : ''}`)
    .join('\n');
  const footer = visible.length > 20 ? `\n... and ${visible.length - 20} more folders` : '';
  const summary = `${visible.length} folders:\n${rows}${footer}`;
  ctx.sendEvent({ type: 'tool_result', tool: 'folder.list', summary: `${visible.length} folders`, success: true });
  return summary;
}
