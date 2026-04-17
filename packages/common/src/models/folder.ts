/**
 * Grafana ref: pkg/services/folder/model.go::Folder
 * See docs/auth-perm-design/01-database-schema.md §folder
 *
 * Hierarchical folder. `parentUid` null => root. Depth limit = 8 (enforced in
 * FolderRepository per Grafana convention).
 *
 * This is distinct from the legacy openobs `folders` (plural) table kept in
 * db/sqlite-schema.ts until T9.6 cleanup.
 */
export interface GrafanaFolder {
  id: string;
  uid: string;
  orgId: string;
  title: string;
  description: string | null;
  parentUid: string | null;
  created: string;
  updated: string;
  createdBy: string | null;
  updatedBy: string | null;
}

export interface NewGrafanaFolder {
  id?: string;
  uid: string;
  orgId: string;
  title: string;
  description?: string | null;
  parentUid?: string | null;
  createdBy?: string | null;
  updatedBy?: string | null;
}

export interface GrafanaFolderPatch {
  title?: string;
  description?: string | null;
  parentUid?: string | null;
  updatedBy?: string | null;
}

export const FOLDER_MAX_DEPTH = 8;
