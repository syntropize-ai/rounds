/**
 * Repository interface for dashboards (W6 / T6.A1).
 *
 * Mirrors the W2 pattern: interface lives in @agentic-obs/common so any
 * consumer (api-gateway routes, background workers, web) can depend on
 * the shape without pulling in a SQLite-specific implementation.
 *
 * Implementation lives in:
 *   packages/data-layer/src/repository/sqlite/dashboard.ts  (DashboardRepository)
 *
 * Semantics: absent rows / no-op updates return `null` (W2 convention).
 * The legacy in-memory `DashboardStore` returned `undefined` for the same
 * cases — callers migrating to this repository must update `=== undefined`
 * checks to `=== null` (or `== null` if both are acceptable).
 */

import type {
  Dashboard,
  DashboardStatus,
  DashboardVariable,
  PanelConfig,
} from '../../models/dashboard.js';
import type { ResourceSource, ResourceProvenance } from '../../resources/writable-gate.js';

/**
 * Input shape for `create()`. Matches the argument surface of the old
 * `DashboardStore.create` so callers can swap implementations without a
 * type churn.
 */
export interface NewDashboardInput {
  title: string;
  description: string;
  prompt: string;
  userId: string;
  datasourceIds: string[];
  useExistingMetrics?: boolean;
  folder?: string;
  workspaceId?: string;
  /** Defaults to `'manual'` when unset. */
  source?: ResourceSource;
  provenance?: ResourceProvenance;
}

/**
 * Patch shape for generic `update()`. Status / panels / variables have
 * dedicated methods below — use those instead of jamming everything into
 * a generic patch so call sites remain grep-able.
 */
export type DashboardPatch = Partial<
  Pick<
    Dashboard,
    | 'type'
    | 'title'
    | 'description'
    | 'panels'
    | 'variables'
    | 'refreshIntervalSec'
    | 'folder'
  >
>;

export interface IDashboardRepository {
  // -- Core CRUD ------------------------------------------------------

  create(input: NewDashboardInput): Promise<Dashboard>;
  /** Returns null when the id is unknown. */
  findById(id: string): Promise<Dashboard | null>;
  /** When `userId` is undefined, returns every dashboard. */
  findAll(userId?: string): Promise<Dashboard[]>;
  listByWorkspace(workspaceId: string): Promise<Dashboard[]>;

  /** Returns null when the id is unknown (no-op update). */
  update(id: string, patch: DashboardPatch): Promise<Dashboard | null>;
  /** Returns null when the id is unknown. */
  updateStatus(
    id: string,
    status: DashboardStatus,
    error?: string,
  ): Promise<Dashboard | null>;
  /** Returns null when the id is unknown. */
  updatePanels(id: string, panels: PanelConfig[]): Promise<Dashboard | null>;
  /** Returns null when the id is unknown. */
  updateVariables(
    id: string,
    variables: DashboardVariable[],
  ): Promise<Dashboard | null>;

  delete(id: string): Promise<boolean>;

  /**
   * Resolve the folder UID for a dashboard within an org. Used by RBAC
   * resolvers to enforce folder-scoped permissions.
   */
  getFolderUid(orgId: string, dashboardId: string): Promise<string | null>;

  // -- Persistence shim (compat with in-memory Persistable) -----------
  //
  // The legacy store implemented Persistable (toJSON / loadJSON) so the
  // gateway's snapshot layer could serialize state to disk. SQLite is
  // the snapshot now, so these become trivial:
  //
  //   size()    -> COUNT(*)
  //   clear()   -> DELETE FROM dashboards
  //   toJSON()  -> SELECT * (returns a plain array)
  //   loadJSON()-> INSERT OR REPLACE over the supplied array
  //
  // They stay on the interface only so routes that still call them
  // (e.g. persistence bootstrap / tests) don't have to branch on backend.

  size(): Promise<number>;
  clear(): Promise<void>;
  toJSON(): Promise<Dashboard[]>;
  loadJSON(data: unknown): Promise<void>;
}
