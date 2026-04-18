/**
 * Barrel exports for the reusable permissions dialog.
 *
 * Wave 5-C / T8.7 — see docs/auth-perm-design/09-frontend.md §T8.7.
 */
export { PermissionsDialog, default } from './PermissionsDialog.js';
export type { PermissionsDialogProps } from './PermissionsDialog.js';
export { PermissionRowEditable, PermissionRowInherited } from './PermissionRow.js';
export { AddPermissionFlyout } from './AddPermissionFlyout.js';
export { UserSearchField } from './UserSearchField.js';
export type { UserSearchResult } from './UserSearchField.js';
export { TeamSearchField } from './TeamSearchField.js';
export type { TeamSearchResult } from './TeamSearchField.js';
export {
  resolveListEndpoint,
  resolveSetEndpoint,
  splitBuckets,
  entryToDraft,
  buildSavePayload,
  draftKey,
  levelLabel,
  principalIcon,
  upsertDraft,
  type DraftDirectEntry,
} from './helpers.js';
