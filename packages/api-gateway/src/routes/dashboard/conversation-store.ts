import type { DashboardMessage } from '@agentic-obs/common'
import type { IConversationStore } from '../../repositories/types.js'
import type { Persistable } from '../../persistence.js'
import { markDirty } from '../../persistence.js'

export class ConversationStore implements IConversationStore, Persistable {
  private readonly messages = new Map<string, DashboardMessage[]>()
  private readonly maxMessagesPerDashboard: number

  constructor(maxMessagesPerDashboard = 200) {
    this.maxMessagesPerDashboard = maxMessagesPerDashboard
  }

  addMessage(dashboardId: string, msg: DashboardMessage): DashboardMessage {
    const existing = this.messages.get(dashboardId) ?? []
    existing.push(msg)
    if (existing.length > this.maxMessagesPerDashboard) {
      existing.splice(0, existing.length - this.maxMessagesPerDashboard)
    }
    this.messages.set(dashboardId, existing)
    markDirty()
    return msg
  }

  getMessages(dashboardId: string): DashboardMessage[] {
    return this.messages.get(dashboardId) ?? []
  }

  clearMessages(dashboardId: string): void {
    this.messages.delete(dashboardId)
  }

  deleteConversation(dashboardId: string): void {
    this.messages.delete(dashboardId)
    markDirty()
  }

  toJSON(): unknown {
    const obj: Record<string, DashboardMessage[]> = {}
    for (const [k, v] of this.messages) {
      obj[k] = v
    }
    return obj
  }

  loadJSON(data: unknown): void {
    const obj = data as Record<string, DashboardMessage[]>
    for (const [k, v] of Object.entries(obj)) {
      if (Array.isArray(v))
        this.messages.set(k, v)
    }
  }
}

/** Module-level singleton - replace with DI in production */
export const defaultConversationStore = new ConversationStore()
