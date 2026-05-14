/**
 * resource_promote — Wave 2 step 1.
 *
 * Promotes a personal-draft dashboard or alert rule into a shared folder.
 * Mirrors the REST `/api/resources/:kind/:id/promote` semantics so the
 * agent and the UI agree on classification and audit shape.
 *
 * Risk classification (matches docs/design/rfc-safety-patterns.md and the
 * action-guard matrix):
 *   - personal → shared:    risk = high
 *     - user_conversation:  confirmationMode = strong_user_confirm
 *     - background_agent:   confirmationMode = formal_approval
 *   - shared → shared:      risk = medium (folder move within shared space)
 *
 * Audit: writes the matching `dashboard.promote` / `alert_rule.promote`
 * entry through `ctx.auditWriter`.
 *
 * Provisioned: refuses via `assertWritable` — provisioned resources must
 * be forked first (Wave 2 step 5).
 */

import {
  ac,
  ACTIONS,
  AuditAction,
  assertWritable,
  ProvisionedResourceError,
} from '@agentic-obs/common';
import type { ActionContext } from './_context.js';
import { withToolEventBoundary } from './_shared.js';

type PromoteKind = 'dashboard' | 'alert_rule';

function parseKind(raw: unknown): PromoteKind | null {
  return raw === 'dashboard' || raw === 'alert_rule' ? raw : null;
}

export async function handleResourcePromote(
  ctx: ActionContext,
  args: Record<string, unknown>,
): Promise<string> {
  const kind = parseKind(args.kind);
  if (!kind) {
    return "Error: 'kind' must be 'dashboard' or 'alert_rule'.";
  }
  const id = typeof args.id === 'string' ? args.id.trim() : '';
  if (!id) return "Error: 'id' is required.";
  const targetFolderUid =
    typeof args.target_folder_uid === 'string' ? args.target_folder_uid.trim() : '';
  if (!targetFolderUid) return "Error: 'target_folder_uid' is required.";
  const owner = typeof args.owner === 'string' ? args.owner : undefined;
  const description = typeof args.description === 'string' ? args.description : undefined;

  if (!ctx.folderRepository) {
    return 'Error: folder backend not configured; cannot promote.';
  }

  return withToolEventBoundary(
    ctx.sendEvent,
    'resource_promote',
    { kind, id, targetFolderUid },
    `Promoting ${kind} ${id} → folder ${targetFolderUid}`,
    async () => {
      const target = await ctx.folderRepository!.findByUid(ctx.identity.orgId, targetFolderUid);
      if (!target) {
        return `Error: target folder ${targetFolderUid} not found.`;
      }
      if ((target.kind ?? 'shared') !== 'shared') {
        return `Error: target folder ${target.uid} is not a shared folder (kind=${target.kind}).`;
      }

      // Resource lookup + source-folder detection.
      let resourceName = '';
      let currentFolderUid: string | null = null;
      let ownerUserId = '';
      let source: import('@agentic-obs/common').ResourceSource = 'manual';

      if (kind === 'dashboard') {
        const dashboard = await ctx.store.findById(id);
        if (!dashboard || dashboard.workspaceId !== ctx.identity.orgId) {
          return `Error: dashboard ${id} not found.`;
        }
        resourceName = dashboard.title;
        currentFolderUid = dashboard.folder ?? null;
        ownerUserId = dashboard.userId;
        source = dashboard.source ?? 'manual';
      } else {
        if (!ctx.alertRuleStore.findById) {
          return 'Error: alert rule store does not support findById.';
        }
        const rule = (await ctx.alertRuleStore.findById(id)) as
          | import('@agentic-obs/common').AlertRule
          | undefined;
        if (!rule) return `Error: alert rule ${id} not found.`;
        resourceName = rule.name;
        currentFolderUid = rule.folderUid ?? null;
        ownerUserId = rule.createdBy;
        source = rule.source ?? 'manual';
      }

      try {
        assertWritable({ kind, id, source });
      } catch (err) {
        if (err instanceof ProvisionedResourceError) {
          return `Error: ${err.message}`;
        }
        throw err;
      }

      // Permission check: write on source UID + write on target folder.
      const srcAction = kind === 'dashboard' ? ACTIONS.DashboardsWrite : ACTIONS.AlertRulesWrite;
      const srcRes =
        kind === 'dashboard' ? `dashboards:uid:${id}` : `alert.rules:uid:${id}`;
      const srcOk = await ctx.accessControl.evaluate(
        ctx.identity,
        ac.eval(srcAction, srcRes),
      );
      if (!srcOk) {
        return `Error: forbidden — missing ${srcAction} on ${kind} ${id}.`;
      }
      const dstOk = await ctx.accessControl.evaluate(
        ctx.identity,
        ac.eval(srcAction, `folders:uid:${target.uid}`),
      );
      if (!dstOk) {
        return `Error: forbidden — missing ${srcAction} on target folder ${target.uid}.`;
      }

      // Apply the move. Description tidy-up rides along as a convenience for
      // the chat surface (the user often refines the title/desc on promote).
      if (kind === 'dashboard') {
        await ctx.store.update(id, {
          folder: target.uid,
          ...(description !== undefined ? { description } : {}),
        } as Parameters<typeof ctx.store.update>[1]);
      } else if (ctx.alertRuleStore.update) {
        await ctx.alertRuleStore.update(id, {
          folderUid: target.uid,
          ...(description !== undefined ? { description } : {}),
          ...(owner !== undefined && owner !== ownerUserId ? { createdBy: owner } : {}),
        });
      } else {
        return 'Error: alert rule store does not support update.';
      }

      const ownerChange =
        owner !== undefined && owner !== ownerUserId
          ? { from: ownerUserId, to: owner }
          : undefined;
      void ctx.auditWriter?.({
        action: kind === 'dashboard' ? AuditAction.DashboardPromote : AuditAction.AlertRulePromote,
        actorType: 'user',
        actorId: ctx.identity.userId,
        orgId: ctx.identity.orgId,
        targetType: kind === 'dashboard' ? 'dashboard' : 'alert_rule',
        targetId: id,
        targetName: resourceName,
        outcome: 'success',
        metadata: {
          fromFolder: currentFolderUid,
          toFolder: target.uid,
          ...(ownerChange ? { ownerChange } : {}),
        },
      });

      return `Promoted ${kind} "${resourceName}" (id: ${id}) ${currentFolderUid ? `from folder ${currentFolderUid} ` : ''}to "${target.title}" (uid: ${target.uid}).`;
    },
  );
}
