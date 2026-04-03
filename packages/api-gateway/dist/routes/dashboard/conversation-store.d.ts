import type { DashboardMessage } from '@agentic-obs/common';
import type { IConversationStore } from '../../repositories/types.js';
import type { Persistable } from '../../persistence.js';
export declare class ConversationStore implements IConversationStore, Persistable {
    private readonly messages;
    private readonly maxMessagesPerDashboard;
    constructor(maxMessagesPerDashboard?: number);
    addMessage(dashboardId: string, msg: DashboardMessage): DashboardMessage;
    getMessages(dashboardId: string): DashboardMessage[];
    clearMessages(dashboardId: string): void;
    deleteConversation(dashboardId: string): void;
    toJSON(): unknown;
    loadJSON(data: unknown): void;
}
/** Module-level singleton - replace with DI in production */
export declare const defaultConversationStore: ConversationStore;
//# sourceMappingURL=conversation-store.d.ts.map