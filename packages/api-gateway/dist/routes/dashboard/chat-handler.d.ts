import type { Request, Response } from 'express';
import type { IGatewayDashboardStore, IConversationStore } from '../../repositories/types.js';
export declare function handleChatMessage(req: Request, res: Response, dashboardId: string, message: string, store: IGatewayDashboardStore, conversationStore: IConversationStore): Promise<void>;
//# sourceMappingURL=chat-handler.d.ts.map
