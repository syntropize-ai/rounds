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
