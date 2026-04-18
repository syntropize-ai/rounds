/**
 * Pure helpers for <PermissionsDialog>.
 *
 * Keeps endpoint routing, payload shaping and bucket split out of the React
 * tree so they can be unit-tested without DOM rendering. Behaviour mirrors
 * docs/auth-perm-design/07-resource-permissions.md and
 * docs/auth-perm-design/08-api-surface.md §permissions.
 *
 * License hygiene: written from design docs, no verbatim Grafana port.
 */
import type {
  BuiltInRoleName,
  PermissionLevel,
  ResourceKind,
  ResourcePermissionEntry,
  ResourcePermissionSetItem,
} from '@agentic-obs/common';

/** Shape of a pending direct permission the UI is tracking locally. */
export type DraftDirectEntry =
  | { kind: 'user'; userId: string; label: string; level: PermissionLevel }
  | { kind: 'team'; teamId: string; label: string; level: PermissionLevel }
  | { kind: 'role'; role: BuiltInRoleName; label: string; level: PermissionLevel };

/** Build the GET endpoint for a resource's permissions. */
export function resolveListEndpoint(resource: ResourceKind, uid: string): string {
  switch (resource) {
    case 'folders':
      return `/folders/${encodeURIComponent(uid)}/permissions`;
    case 'dashboards':
      return `/dashboards/uid/${encodeURIComponent(uid)}/permissions`;
    case 'datasources':
      return `/datasources/${encodeURIComponent(uid)}/permissions`;
    case 'alert.rules':
      return `/access-control/alert.rules/${encodeURIComponent(uid)}/permissions`;
  }
}

/** Build the POST endpoint for bulk-setting a resource's permissions. */
export function resolveSetEndpoint(resource: ResourceKind, uid: string): string {
  // Grafana parity: GET and POST share the same path.
  return resolveListEndpoint(resource, uid);
}

/** Split a permission list into inherited and direct buckets. */
export function splitBuckets(entries: readonly ResourcePermissionEntry[]): {
  inherited: ResourcePermissionEntry[];
  direct: ResourcePermissionEntry[];
} {
  const inherited: ResourcePermissionEntry[] = [];
  const direct: ResourcePermissionEntry[] = [];
  for (const e of entries) {
    if (e.isInherited) inherited.push(e);
    else direct.push(e);
  }
  return { inherited, direct };
}

/** Lower a raw direct entry from the server into the editable draft form. */
export function entryToDraft(entry: ResourcePermissionEntry): DraftDirectEntry | null {
  if (entry.userId) {
    return {
      kind: 'user',
      userId: entry.userId,
      label: entry.userEmail ?? entry.userLogin ?? entry.userId,
      level: entry.permission,
    };
  }
  if (entry.teamId) {
    return {
      kind: 'team',
      teamId: entry.teamId,
      label: entry.teamName ?? entry.teamId,
      level: entry.permission,
    };
  }
  if (entry.builtInRole) {
    return {
      kind: 'role',
      role: entry.builtInRole,
      label: entry.builtInRole,
      level: entry.permission,
    };
  }
  return null;
}

/** Build the `items[]` payload for POST. */
export function buildSavePayload(
  drafts: readonly DraftDirectEntry[],
): { items: ResourcePermissionSetItem[] } {
  const items: ResourcePermissionSetItem[] = drafts.map((d) => {
    switch (d.kind) {
      case 'user':
        return { userId: d.userId, permission: d.level };
      case 'team':
        return { teamId: d.teamId, permission: d.level };
      case 'role':
        return { role: d.role, permission: d.level };
    }
  });
  return { items };
}

/**
 * Stable identity for a draft row. Used as React key + for duplicate detection
 * when adding a new principal (no duplicate role/user/team grant allowed).
 */
export function draftKey(d: DraftDirectEntry): string {
  switch (d.kind) {
    case 'user':
      return `user:${d.userId}`;
    case 'team':
      return `team:${d.teamId}`;
    case 'role':
      return `role:${d.role}`;
  }
}

/** Human-readable level label shown in the dropdown. */
export function levelLabel(level: PermissionLevel): string {
  switch (level) {
    case 1:
      return 'View';
    case 2:
      return 'Edit';
    case 4:
      return 'Admin';
  }
}

/** Principal-type glyph. Ascii fallbacks (emoji render differently per-OS). */
export function principalIcon(kind: DraftDirectEntry['kind']): string {
  switch (kind) {
    case 'user':
      return 'User';
    case 'team':
      return 'Team';
    case 'role':
      return 'Role';
  }
}

/**
 * Merge a new draft into an existing list, replacing a duplicate by key so
 * the UI can't create two rows for the same principal (matches Grafana's
 * add-permission flow, which updates rather than dupes).
 */
export function upsertDraft(
  existing: readonly DraftDirectEntry[],
  next: DraftDirectEntry,
): DraftDirectEntry[] {
  const key = draftKey(next);
  const out = existing.filter((d) => draftKey(d) !== key);
  out.push(next);
  return out;
}
