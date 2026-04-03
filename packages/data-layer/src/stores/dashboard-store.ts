// In-memory store for dashboards

import type { Dashboard, DashboardStatus, DashboardVariable, PanelConfig } from '@agentic-obs/common'
import type { Persistable } from './persistence.js'
import { markDirty } from './persistence.js'
import { defaultVersionStore } from './version-store.js'

function uid(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

export class DashboardStore implements Persistable {
  private readonly dashboards = new Map<string, Dashboard>()
  private readonly maxCapacity: number

  constructor(maxCapacity = 500) {
    this.maxCapacity = maxCapacity
  }

  create(params: {
    title: string
    description: string
    prompt: string
    userId: string
    datasourceIds: string[]
    useExistingMetrics?: boolean
    folder?: string
    workspaceId?: string
  }): Dashboard {
    const now = new Date().toISOString()
    const id = uid()

    const dashboard: Dashboard = {
      id,
      type: 'dashboard',
      title: params.title,
      description: params.description,
      prompt: params.prompt,
      userId: params.userId,
      status: 'generating',
      panels: [],
      variables: [],
      refreshIntervalSec: 30,
      datasourceIds: params.datasourceIds,
      useExistingMetrics: params.useExistingMetrics ?? true,
      ...(params.folder !== undefined ? { folder: params.folder } : {}),
      ...(params.workspaceId !== undefined ? { workspaceId: params.workspaceId } : {}),
      createdAt: now,
      updatedAt: now,
    }

    this.dashboards.set(id, dashboard)
    this.evictIfNeeded()
    markDirty()
    defaultVersionStore.record('dashboard', id, dashboard, params.userId, 'human', 'Initial creation')
    return dashboard
  }

  private evictIfNeeded(): void {
    if (this.dashboards.size <= this.maxCapacity)
      return

    let oldest: Dashboard | undefined
    for (const d of this.dashboards.values()) {
      if ((d.status === 'ready' || d.status === 'failed')) {
        if (!oldest || d.createdAt < oldest.createdAt) {
          oldest = d
        }
      }
    }

    if (oldest) {
      this.dashboards.delete(oldest.id)
    }
  }

  findById(id: string): Dashboard | undefined {
    return this.dashboards.get(id)
  }

  findAll(userId?: string): Dashboard[] {
    const all = [...this.dashboards.values()]
    if (userId === undefined)
      return all
    return all.filter((d) => d.userId === userId)
  }

  listByWorkspace(workspaceId: string): Dashboard[] {
    const result: Dashboard[] = []
    for (const d of this.dashboards.values()) {
      if (d.workspaceId === workspaceId) result.push(d)
    }
    return result
  }

  update(
    id: string,
    patch: Partial<Pick<Dashboard, 'type' | 'title' | 'description' | 'panels' | 'variables' | 'refreshIntervalSec' | 'updatedAt' | 'folder'>>,
  ): Dashboard | undefined {
    const d = this.dashboards.get(id)
    if (!d)
      return undefined
    const updated = { ...d, ...patch, updatedAt: new Date().toISOString() }
    this.dashboards.set(id, updated)
    markDirty()
    defaultVersionStore.record('dashboard', id, updated, d.userId, 'human')
    return updated
  }

  updateStatus(id: string, status: DashboardStatus, error?: string): Dashboard | undefined {
    const d = this.dashboards.get(id)
    if (!d)
      return undefined
    const updated = { ...d, status, updatedAt: new Date().toISOString() }
    if (error !== undefined)
      updated.error = error
    this.dashboards.set(id, updated)
    markDirty()
    return updated
  }

  updatePanels(id: string, panels: PanelConfig[]): Dashboard | undefined {
    const d = this.dashboards.get(id)
    if (!d)
      return undefined
    const updated = { ...d, panels, updatedAt: new Date().toISOString() }
    this.dashboards.set(id, updated)
    markDirty()
    return updated
  }

  updateVariables(id: string, variables: DashboardVariable[]): Dashboard | undefined {
    const d = this.dashboards.get(id)
    if (!d)
      return undefined
    const updated = { ...d, variables, updatedAt: new Date().toISOString() }
    this.dashboards.set(id, updated)
    markDirty()
    return updated
  }

  delete(id: string): boolean {
    const result = this.dashboards.delete(id)
    if (result)
      markDirty()
    return result
  }

  get size(): number {
    return this.dashboards.size
  }

  clear(): void {
    this.dashboards.clear()
  }

  toJSON(): unknown {
    return [...this.dashboards.values()]
  }

  loadJSON(data: unknown): void {
    if (!Array.isArray(data))
      return
    for (const d of data as Dashboard[]) {
      if (d.id)
        this.dashboards.set(d.id, d)
    }
  }
}

/** Module-level singleton - replace with DI in production */
export const defaultDashboardStore = new DashboardStore()
