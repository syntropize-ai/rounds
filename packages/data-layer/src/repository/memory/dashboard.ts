/**
 * InMemoryDashboardRepository — in-memory implementation of the canonical
 * `IDashboardRepository` from `@agentic-obs/common`.
 *
 * Per ADR-001 (M1 dashboard migration): the legacy `DashboardStore` is
 * gone. Tests that previously held an in-memory `DashboardStore` use this
 * class instead — it implements the same async, null-returning shape as
 * the SQLite/Postgres repositories so production and test paths agree on
 * one type.
 */

import { randomUUID } from 'node:crypto';
import type {
  Dashboard,
  DashboardStatus,
  DashboardVariable,
  IDashboardRepository,
  NewDashboardInput,
  DashboardPatch,
  PanelConfig,
} from '@agentic-obs/common';

function nowIso(): string {
  return new Date().toISOString();
}

export class InMemoryDashboardRepository implements IDashboardRepository {
  private readonly dashboards = new Map<string, Dashboard>();

  async create(input: NewDashboardInput): Promise<Dashboard> {
    const now = nowIso();
    const id = randomUUID();
    const dashboard: Dashboard = {
      id,
      type: 'dashboard',
      title: input.title,
      description: input.description,
      prompt: input.prompt,
      userId: input.userId,
      status: 'generating',
      panels: [],
      variables: [],
      refreshIntervalSec: 30,
      datasourceIds: input.datasourceIds,
      useExistingMetrics: input.useExistingMetrics ?? true,
      ...(input.folder !== undefined ? { folder: input.folder } : {}),
      ...(input.workspaceId !== undefined ? { workspaceId: input.workspaceId } : {}),
      source: input.source ?? 'manual',
      ...(input.provenance !== undefined ? { provenance: input.provenance } : {}),
      createdAt: now,
      updatedAt: now,
    };
    this.dashboards.set(id, dashboard);
    return dashboard;
  }

  async findById(id: string): Promise<Dashboard | null> {
    return this.dashboards.get(id) ?? null;
  }

  async findAll(userId?: string): Promise<Dashboard[]> {
    const all = [...this.dashboards.values()];
    if (userId === undefined) return all;
    return all.filter((d) => d.userId === userId);
  }

  async listByWorkspace(workspaceId: string): Promise<Dashboard[]> {
    return [...this.dashboards.values()].filter((d) => d.workspaceId === workspaceId);
  }

  async update(id: string, patch: DashboardPatch): Promise<Dashboard | null> {
    const d = this.dashboards.get(id);
    if (!d) return null;
    const updated: Dashboard = { ...d, ...patch, updatedAt: nowIso() };
    this.dashboards.set(id, updated);
    return updated;
  }

  async updateStatus(
    id: string,
    status: DashboardStatus,
    error?: string,
  ): Promise<Dashboard | null> {
    const d = this.dashboards.get(id);
    if (!d) return null;
    const updated: Dashboard = { ...d, status, updatedAt: nowIso() };
    if (error !== undefined) updated.error = error;
    this.dashboards.set(id, updated);
    return updated;
  }

  async updatePanels(id: string, panels: PanelConfig[]): Promise<Dashboard | null> {
    const d = this.dashboards.get(id);
    if (!d) return null;
    const updated: Dashboard = { ...d, panels, updatedAt: nowIso() };
    this.dashboards.set(id, updated);
    return updated;
  }

  async updateVariables(
    id: string,
    variables: DashboardVariable[],
  ): Promise<Dashboard | null> {
    const d = this.dashboards.get(id);
    if (!d) return null;
    const updated: Dashboard = { ...d, variables, updatedAt: nowIso() };
    this.dashboards.set(id, updated);
    return updated;
  }

  async delete(id: string): Promise<boolean> {
    return this.dashboards.delete(id);
  }

  /**
   * In-memory analogue of the SQL `getFolderUid`. The in-memory fixture
   * has no separate `org_id` column — dashboards are scoped by
   * `workspaceId`, which is what production uses as the org id at the
   * route boundary. Match on that and return the dashboard's `folder`
   * field as its folder uid.
   */
  async getFolderUid(orgId: string, dashboardId: string): Promise<string | null> {
    const d = this.dashboards.get(dashboardId);
    if (!d) return null;
    if (d.workspaceId !== undefined && d.workspaceId !== orgId) return null;
    return d.folder ?? null;
  }

  async size(): Promise<number> {
    return this.dashboards.size;
  }

  async clear(): Promise<void> {
    this.dashboards.clear();
  }

  async toJSON(): Promise<Dashboard[]> {
    return [...this.dashboards.values()];
  }

  async loadJSON(data: unknown): Promise<void> {
    if (!Array.isArray(data)) return;
    for (const d of data as Dashboard[]) {
      if (d && typeof d.id === 'string' && d.id !== '') {
        this.dashboards.set(d.id, d);
      }
    }
  }
}
