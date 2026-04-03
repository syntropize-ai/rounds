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
        markDirty();
        return msg;
    }
    getMessages(dashboardId) {
        return this.messages.get(dashboardId) ?? [];
    }
    clearMessages(dashboardId) {
        this.messages.delete(dashboardId);
    }
    deleteConversation(dashboardId) {
        this.messages.delete(dashboardId);
        markDirty();
    }
    toJSON() {
        const obj = {};
        for (const [k, v] of this.messages) {
            obj[k] = v;
        }
        return obj;
    }
    loadJSON(data) {
        const obj = data;
        for (const [k, v] of Object.entries(obj)) {
            if (Array.isArray(v))
                this.messages.set(k, v);
        }
    }
}
/** Module-level singleton - replace with DI in production */
export const defaultConversationStore = new ConversationStore();
//# sourceMappingURL=conversation-store.js.map