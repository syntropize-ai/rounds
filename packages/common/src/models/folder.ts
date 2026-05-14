/**
 * Grafana ref: pkg/services/folder/model.go::Folder
 * See docs/auth-perm-design/01-database-schema.md §folder
 *
 * Hierarchical folder. `parentUid` null => root. Depth limit = 8 (enforced in
 * FolderRepository per Grafana convention).
 *
 * This is distinct from the legacy Rounds `folders` (plural) table kept in
 * db/sqlite-schema.ts until T9.6 cleanup.
 */
import type { ResourceSource, ResourceProvenance } from '../resources/writable-gate.js';

/**
 * Workspace kind. `'personal'` folders are scoped to a single user's
 * "My Workspace" — drafts live here while being authored. `'shared'`
 * folders are team/service folders that other people can read. The
 * promote flow (Wave 2 step 1) moves a resource personal → shared.
 *
 * Treat absence as `'shared'` (most folders pre-dating this field are
 * team folders; personal folders are explicitly seeded with the marker).
 */
export type FolderKind = 'personal' | 'shared';

export interface GrafanaFolder {
  id: string;
  uid: string;
  orgId: string;
  title: string;
  description: string | null;
  parentUid: string | null;
  /** See {@link FolderKind}. Absence → `'shared'`. */
  kind?: FolderKind;
  /** When `kind === 'personal'`, the userId that owns the workspace. */
  ownerUserId?: string | null;
  created: string;
  updated: string;
  createdBy: string | null;
  updatedBy: string | null;
  /** Origin marker — see writable-gate.ts. Treat absence as `'manual'`. */
  source?: ResourceSource;
  provenance?: ResourceProvenance;
}

export interface NewGrafanaFolder {
  id?: string;
  uid: string;
  orgId: string;
  title: string;
  description?: string | null;
  parentUid?: string | null;
  kind?: FolderKind;
  ownerUserId?: string | null;
  createdBy?: string | null;
  updatedBy?: string | null;
  source?: ResourceSource;
  provenance?: ResourceProvenance;
}

export interface GrafanaFolderPatch {
  title?: string;
  description?: string | null;
  parentUid?: string | null;
  updatedBy?: string | null;
}

export const FOLDER_MAX_DEPTH = 8;
