/**
 * Promote service — Wave 2 step 1.
 *
 * Moves a personal-draft resource (dashboard or alert rule) out of a
 * user's "My Workspace" (folder.kind === 'personal') into a shared
 * team/service folder (folder.kind === 'shared').
 *
 * Promote does NOT copy. The resource UID stays the same — only the
 * containing folder pointer (`dashboard.folder` / `alertRule.folderUid`)
 * is updated. Cross-resource links remain unbroken.
 *
 * Why a separate service (vs. a PUT/folder patch):
 *   1. Permission boundary crosses — RBAC asserts BOTH source and
 *      target folder write access in one place.
 *   2. GuardedAction integration — promote is classified as `high` risk
 *      and (for user-driven calls) requires `strong_user_confirm`.
 *   3. Distinct audit action — `DashboardPromote` / `AlertRulePromote`
 *      so operators can filter promotions out of routine `update` noise.
 *   4. Refuses provisioned resources (must `fork` first — Wave 2 step 5).
 *
 * The agent tool `resource_promote` is a thin wrapper around this service.
 */

import {
  ACTIONS,
  ac,
  AuditAction,
  assertWritable,
  ProvisionedResourceError,
} from '@agentic-obs/common';
import type {
  AlertRule,
  Dashboard,
  GrafanaFolder,
  Identity,
  IFolderRepository,
} from '@agentic-obs/common';
import type { IAlertRuleRepository, IGatewayDashboardStore } from '@agentic-obs/data-layer';
import type { AuditWriter } from '../auth/audit-writer.js';
import type { AccessControlSurface } from './accesscontrol-holder.js';

export type PromoteKind = 'dashboard' | 'alert_rule';

export interface PromoteInput {
  kind: PromoteKind;
  id: string;
  targetFolderUid: string;
  /** Optional new owner for the promoted resource. */
  owner?: string;
  /** Optional updated description (UI lets users tidy the draft on promote). */
  description?: string;
}

export interface PromotePreview {
  kind: PromoteKind;
  id: string;
  resourceName: string;
  currentFolderUid: string | null;
  currentFolderTitle: string | null;
  targetFolderUid: string;
  targetFolderTitle: string;
  /** Visibility expansion message for the confirm dialog. */
  visibility: string;
  ownerUserId: string;
  ownerChange?: { from: string; to: string };
  /** Per the action-guard matrix for user_conversation/manual_ui × high. */
  confirmationMode: 'strong_user_confirm';
}

export interface PromoteResult {
  kind: PromoteKind;
  id: string;
  fromFolderUid: string | null;
  toFolderUid: string;
  ownerChange?: { from: string; to: string };
}

export class PromoteServiceError extends Error {
  constructor(public readonly statusCode: number, message: string) {
    super(message);
    this.name = 'PromoteServiceError';
  }
}

export interface PromoteServiceDeps {
  dashboards: IGatewayDashboardStore;
  alertRules: IAlertRuleRepository;
  folders: IFolderRepository;
  accessControl: AccessControlSurface;
  audit?: AuditWriter;
}

/**
 * Result of fetching a resource + its current folder. Internal-only; the
 * preview/promote paths share the lookup.
 */
interface ResourceLookup {
  kind: PromoteKind;
  id: string;
  name: string;
  /** Resource's current folder uid (dashboard.folder / alertRule.folderUid). */
  currentFolderUid: string | null;
  ownerUserId: string;
  source: import('@agentic-obs/common').ResourceSource;
  /** The current folder row (null when the resource has no folder pointer). */
  currentFolder: GrafanaFolder | null;
}

export class PromoteService {
  constructor(private readonly deps: PromoteServiceDeps) {}

  // -- Public API ------------------------------------------------------------

  async preview(identity: Identity, input: PromoteInput): Promise<PromotePreview> {
    const { lookup, target } = await this.resolve(identity.orgId, input);
    await this.assertPermissions(identity, lookup, target);
    return buildPreview(lookup, target, input);
  }

  async promote(identity: Identity, input: PromoteInput): Promise<PromoteResult> {
    const { lookup, target } = await this.resolve(identity.orgId, input);
    await this.assertPermissions(identity, lookup, target);

    // Provisioned resources cannot be promoted — they're owned by a file
    // or GitOps pipeline. The user has to fork first (Wave 2 step 5).
    try {
      assertWritable({ kind: lookup.kind, id: lookup.id, source: lookup.source });
    } catch (err) {
      if (err instanceof ProvisionedResourceError) {
        throw new PromoteServiceError(409, err.message);
      }
      throw err;
    }

    const ownerChange =
      input.owner !== undefined && input.owner !== lookup.ownerUserId
        ? { from: lookup.ownerUserId, to: input.owner }
        : undefined;

    if (input.kind === 'dashboard') {
      await this.deps.dashboards.update(input.id, {
        folder: input.targetFolderUid,
        ...(input.description !== undefined ? { description: input.description } : {}),
      });
    } else {
      await this.deps.alertRules.update(input.id, {
        folderUid: input.targetFolderUid,
        ...(input.description !== undefined ? { description: input.description } : {}),
        ...(ownerChange ? { createdBy: ownerChange.to } : {}),
      });
    }

    const auditAction =
      input.kind === 'dashboard' ? AuditAction.DashboardPromote : AuditAction.AlertRulePromote;
    void this.deps.audit?.log({
      action: auditAction,
      actorType: 'user',
      actorId: identity.userId,
      orgId: identity.orgId,
      targetType: input.kind === 'dashboard' ? 'dashboard' : 'alert_rule',
      targetId: input.id,
      targetName: lookup.name,
      outcome: 'success',
      metadata: {
        fromFolder: lookup.currentFolderUid,
        toFolder: input.targetFolderUid,
        ...(ownerChange ? { ownerChange } : {}),
      },
    });

    return {
      kind: input.kind,
      id: input.id,
      fromFolderUid: lookup.currentFolderUid,
      toFolderUid: input.targetFolderUid,
      ...(ownerChange ? { ownerChange } : {}),
    };
  }

  // -- Internal --------------------------------------------------------------

  private async resolve(
    orgId: string,
    input: PromoteInput,
  ): Promise<{ lookup: ResourceLookup; target: GrafanaFolder }> {
    const target = await this.deps.folders.findByUid(orgId, input.targetFolderUid);
    if (!target) {
      throw new PromoteServiceError(404, `target folder ${input.targetFolderUid} not found`);
    }
    // Default `kind` to 'shared' on absence — folders predating the field
    // are team folders. Refusing here keeps the user from accidentally
    // "promoting" into another personal workspace.
    if ((target.kind ?? 'shared') !== 'shared') {
      throw new PromoteServiceError(
        400,
        `target folder ${target.uid} is not a shared folder (kind=${target.kind})`,
      );
    }

    const lookup = await this.fetchResource(orgId, input.kind, input.id);
    return { lookup, target };
  }

  private async fetchResource(
    orgId: string,
    kind: PromoteKind,
    id: string,
  ): Promise<ResourceLookup> {
    if (kind === 'dashboard') {
      const dashboard = (await this.deps.dashboards.findById(id)) as Dashboard | undefined;
      if (!dashboard || dashboard.workspaceId !== orgId) {
        throw new PromoteServiceError(404, `dashboard ${id} not found`);
      }
      const folderUid = dashboard.folder ?? null;
      const currentFolder = folderUid
        ? await this.deps.folders.findByUid(orgId, folderUid)
        : null;
      return {
        kind: 'dashboard',
        id,
        name: dashboard.title,
        currentFolderUid: folderUid,
        ownerUserId: dashboard.userId,
        source: dashboard.source ?? 'manual',
        currentFolder,
      };
    }
    const rule = (await this.deps.alertRules.findById(id)) as AlertRule | undefined;
    if (!rule || (rule as AlertRule & { workspaceId?: string }).workspaceId !== orgId) {
      throw new PromoteServiceError(404, `alert rule ${id} not found`);
    }
    const folderUid = rule.folderUid ?? null;
    const currentFolder = folderUid
      ? await this.deps.folders.findByUid(orgId, folderUid)
      : null;
    return {
      kind: 'alert_rule',
      id,
      name: rule.name,
      currentFolderUid: folderUid,
      ownerUserId: rule.createdBy,
      source: rule.source ?? 'manual',
      currentFolder,
    };
  }

  private async assertPermissions(
    identity: Identity,
    lookup: ResourceLookup,
    target: GrafanaFolder,
  ): Promise<void> {
    // Source: must have write on the existing resource (per UID).
    const srcAction =
      lookup.kind === 'dashboard' ? ACTIONS.DashboardsWrite : ACTIONS.AlertRulesWrite;
    const srcRes =
      lookup.kind === 'dashboard'
        ? `dashboards:uid:${lookup.id}`
        : `alert.rules:uid:${lookup.id}`;
    const srcOk = await this.deps.accessControl.evaluate(identity, ac.eval(srcAction, srcRes));
    if (!srcOk) {
      throw new PromoteServiceError(
        403,
        `forbidden: missing write on source ${lookup.kind} ${lookup.id}`,
      );
    }

    // Target: dashboards:write on the target folder (mirrors the
    // dashboard create gate which authorizes against the destination
    // folder, not the dashboard uid that doesn't exist yet).
    const dstAction =
      lookup.kind === 'dashboard' ? ACTIONS.DashboardsWrite : ACTIONS.AlertRulesWrite;
    const dstOk = await this.deps.accessControl.evaluate(
      identity,
      ac.eval(dstAction, `folders:uid:${target.uid}`),
    );
    if (!dstOk) {
      throw new PromoteServiceError(
        403,
        `forbidden: missing write on target folder ${target.uid}`,
      );
    }
  }
}

function buildPreview(
  lookup: ResourceLookup,
  target: GrafanaFolder,
  input: PromoteInput,
): PromotePreview {
  const targetTitle = target.title;
  const visibility = `Will be visible to everyone with access to "${targetTitle}". Currently visible only to ${lookup.ownerUserId} (personal workspace).`;
  const ownerChange =
    input.owner !== undefined && input.owner !== lookup.ownerUserId
      ? { from: lookup.ownerUserId, to: input.owner }
      : undefined;
  return {
    kind: lookup.kind,
    id: lookup.id,
    resourceName: lookup.name,
    currentFolderUid: lookup.currentFolderUid,
    currentFolderTitle: lookup.currentFolder?.title ?? null,
    targetFolderUid: target.uid,
    targetFolderTitle: targetTitle,
    visibility,
    ownerUserId: lookup.ownerUserId,
    ...(ownerChange ? { ownerChange } : {}),
    // From action-guard.ts pickConfirmationMode: source=manual_ui/user_conversation,
    // risk=high → 'strong_user_confirm'. Promote is high risk because it
    // crosses a permission boundary (personal → shared) and the UID stays
    // the same, so dangling references can't be re-checked after the fact.
    confirmationMode: 'strong_user_confirm',
  };
}
