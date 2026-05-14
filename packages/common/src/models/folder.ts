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
 * Folder kind. `shared` is the default Grafana-parity folder visible per RBAC.
 * `personal` is the per-user "My Workspace" — owned by exactly one user
 * (identified by `uid = 'user:<userId>'`) and hidden from everyone else.
 */
export type FolderKind = 'personal' | 'shared';

export interface GrafanaFolder {
  id: string;
  uid: string;
  orgId: string;
  title: string;
  description: string | null;
  parentUid: string | null;
  kind: FolderKind;
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

/** Returns the deterministic uid used for a user's personal workspace folder. */
export function personalFolderUid(userId: string): string {
  return `user:${userId}`;
}

export const FOLDER_MAX_DEPTH = 8;
