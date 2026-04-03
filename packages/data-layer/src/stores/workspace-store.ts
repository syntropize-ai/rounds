// In-memory store for workspaces

import type { Workspace, WorkspaceMember } from '@agentic-obs/common'
import type { Persistable } from './persistence.js'
import { markDirty } from './persistence.js'

function uid(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

export class WorkspaceStore implements Persistable {
  private readonly workspaces = new Map<string, Workspace>()

  create(params: {
    name: string
    slug: string
    ownerId: string
    settings?: Workspace['settings']
  }): Workspace {
    const now = new Date().toISOString()
    const id = uid()

    const workspace: Workspace = {
      id,
      name: params.name,
      slug: params.slug,
      ownerId: params.ownerId,
      members: [
        {
          userId: params.ownerId,
          role: 'owner',
          joinedAt: now,
        },
      ],
      settings: params.settings ?? {},
      createdAt: now,
      updatedAt: now,
    }

    this.workspaces.set(id, workspace)
    markDirty()
    return workspace
  }

  findById(id: string): Workspace | undefined {
    return this.workspaces.get(id)
  }

  findBySlug(slug: string): Workspace | undefined {
    for (const ws of this.workspaces.values()) {
      if (ws.slug === slug) return ws
    }
    return undefined
  }

  findByMember(userId: string): Workspace[] {
    const result: Workspace[] = []
    for (const ws of this.workspaces.values()) {
      if (ws.members.some((m) => m.userId === userId)) {
        result.push(ws)
      }
    }
    return result
  }

  update(
    id: string,
    patch: Partial<Pick<Workspace, 'name' | 'slug' | 'settings'>>,
  ): Workspace | undefined {
    const ws = this.workspaces.get(id)
    if (!ws) return undefined
    const updated = { ...ws, ...patch, updatedAt: new Date().toISOString() }
    this.workspaces.set(id, updated)
    markDirty()
    return updated
  }

  delete(id: string): boolean {
    const result = this.workspaces.delete(id)
    if (result) markDirty()
    return result
  }

  addMember(
    workspaceId: string,
    member: { userId: string; role: WorkspaceMember['role'] },
  ): Workspace | undefined {
    const ws = this.workspaces.get(workspaceId)
    if (!ws) return undefined

    // Don't add duplicate members
    if (ws.members.some((m) => m.userId === member.userId)) return ws

    const updated: Workspace = {
      ...ws,
      members: [
        ...ws.members,
        {
          userId: member.userId,
          role: member.role,
          joinedAt: new Date().toISOString(),
        },
      ],
      updatedAt: new Date().toISOString(),
    }
    this.workspaces.set(workspaceId, updated)
    markDirty()
    return updated
  }

  removeMember(workspaceId: string, userId: string): Workspace | undefined {
    const ws = this.workspaces.get(workspaceId)
    if (!ws) return undefined

    // Cannot remove the owner
    if (ws.ownerId === userId) return undefined

    const updated: Workspace = {
      ...ws,
      members: ws.members.filter((m) => m.userId !== userId),
      updatedAt: new Date().toISOString(),
    }
    this.workspaces.set(workspaceId, updated)
    markDirty()
    return updated
  }

  get size(): number {
    return this.workspaces.size
  }

  clear(): void {
    this.workspaces.clear()
  }

  toJSON(): unknown {
    return [...this.workspaces.values()]
  }

  loadJSON(data: unknown): void {
    if (!Array.isArray(data)) return
    for (const ws of data as Workspace[]) {
      if (ws.id) this.workspaces.set(ws.id, ws)
    }
  }
}

/** Module-level singleton - replace with DI in production */
export const defaultWorkspaceStore = new WorkspaceStore()
