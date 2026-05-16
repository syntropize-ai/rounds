import { ac, AuditAction } from '@agentic-obs/common';
import type { GrafanaFolder } from '@agentic-obs/common';
import type { ActionContext } from './_context.js';
import { withToolEventBoundary } from './_shared.js';

// ---------------------------------------------------------------------------
// Folder lifecycle (minimal — full UI flow lives in /api/folders; agent tools
// cover the create/list cases the orchestrator needs when asked to organize
// dashboards). Permission gate already validated access.
// ---------------------------------------------------------------------------

export async function handleFolderCreate(
  ctx: ActionContext,
  args: Record<string, unknown>,
): Promise<string> {
  if (!ctx.folderRepository) return 'Error: folder backend not configured on this deployment.';
  const title = String(args.title ?? '').trim();
  if (!title) return 'Error: "title" is required.';
  const parentUid = typeof args.parentUid === 'string' && args.parentUid !== '' ? args.parentUid : null;

  return withToolEventBoundary(
    ctx.sendEvent,
    'folder_create',
    { title, parentUid },
    `Creating folder: ${title}`,
    async () => {
      // Simple uid slug from title; fall back to random if slug collides.
      const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || `folder-${Date.now().toString(36)}`;
      let uid = slug;
      if (await ctx.folderRepository!.findByUid(ctx.identity.orgId, uid)) {
        uid = `${slug}-${Math.random().toString(36).slice(2, 6)}`;
      }

      const folder = await ctx.folderRepository!.create({
        uid,
        orgId: ctx.identity.orgId,
        title,
        parentUid,
        createdBy: ctx.identity.userId,
        updatedBy: ctx.identity.userId,
        // Agent-tool created — see writable-gate.ts for source taxonomy.
        source: 'ai_generated',
      });

      void ctx.auditWriter?.({
        action: AuditAction.FolderCreate,
        actorType: 'user',
        actorId: ctx.identity.userId,
        orgId: ctx.identity.orgId,
        targetType: 'folder',
        targetId: folder.uid,
        targetName: folder.title,
        outcome: 'success',
        metadata: { parentUid: folder.parentUid, via: 'agent_tool' },
      });

      const observation = `Folder "${folder.title}" created (uid=${folder.uid})${folder.parentUid ? ` under ${folder.parentUid}` : ' at root'}.`;
      ctx.emitAgentEvent(ctx.makeAgentEvent('agent.tool_completed', { tool: 'folder_create', folderUid: folder.uid }));
      return observation;
    },
  );
}

export async function handleFolderList(
  ctx: ActionContext,
  args: Record<string, unknown>,
): Promise<string> {
  if (!ctx.folderRepository) return 'Error: folder backend not configured on this deployment.';
  const parentUid = typeof args.parentUid === 'string' ? args.parentUid : null;
  const limit = Math.min(Number(args.limit ?? 50), 200);

  return withToolEventBoundary(
    ctx.sendEvent,
    'folder_list',
    { parentUid, limit },
    'Listing folders',
    async () => {
      const page = await ctx.folderRepository!.list({
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
        return 'No folders visible to you' + (parentUid ? ` under ${parentUid}.` : '.');
      }
      const rows = visible
        .slice(0, 20)
        .map((f) => `- ${f.title} (uid=${f.uid})${f.parentUid ? `, parent=${f.parentUid}` : ''}`)
        .join('\n');
      const footer = visible.length > 20 ? `\n... and ${visible.length - 20} more folders` : '';
      const observation = `${visible.length} folders:\n${rows}${footer}`;
      return { observation, summary: `${visible.length} folders` };
    },
  );
}
