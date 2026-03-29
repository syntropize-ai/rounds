import { markDirty } from '../../persistence.js';

export class ConversationStore {
  messages = new Map();
  maxMessagesPerDashboard;

  constructor(maxMessagesPerDashboard = 200) {
    this.maxMessagesPerDashboard = maxMessagesPerDashboard;
  }

  addMessage(dashboardId, msg) {
    const existing = this.messages.get(dashboardId) ?? [];
    existing.push(msg);
    if (existing.length > this.maxMessagesPerDashboard) {
      existing.splice(0, existing.length - this.maxMessagesPerDashboard);
    }
    this.messages.set(dashboardId, existing);
    markDirty?.();
    return msg;
  }

  getMessages(dashboardId) {
    return this.messages.get(dashboardId) ?? [];
  }

  clearMessages(dashboardId) {
    this.messages.set(dashboardId, []);
    markDirty?.();
  }

  deleteConversation(dashboardId) {
    this.messages.delete(dashboardId);
    markDirty?.();
  }

  serialize() {
    return Object.fromEntries(this.messages);
  }

  deserialize(data) {
    this.messages = new Map(Object.entries(data ?? {}));
  }
}

export const defaultConversationStore = new ConversationStore();
//# sourceMappingURL=conversation-store.js.map
