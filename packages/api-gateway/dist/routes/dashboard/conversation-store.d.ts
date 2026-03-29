import type { DashboardMessage } from '@agentic-obs/common';
import type { IConversationStore } from '../../repositories/types.js';
import type { Persistable } from '../../persistence.js';
export declare class ConversationStore implements IConversationStore, Persistable {
    messages: Map<string, DashboardMessage[]>;
    maxMessagesPerDashboard: number;
    constructor(maxMessagesPerDashboard?: number);
    addMessage(dashboardId: string, msg: DashboardMessage): DashboardMessage;
    getMessages(dashboardId: string): DashboardMessage[];
    clearMessages(dashboardId: string): void;
    deleteConversation(dashboardId: string): void;
    serialize(): unknown;
    deserialize(data: unknown): void;
}
export declare const defaultConversationStore: ConversationStore;
//# sourceMappingURL=conversation-store.d.ts.map
