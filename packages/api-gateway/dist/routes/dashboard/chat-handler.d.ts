import type { Request, Response } from 'express';
import type { IGatewayDashboardStore, IConversationStore } from '../../repositories/types.js';
import type { IInvestigationReportRepository, IAlertRuleRepository, IGatewayInvestigationStore, IGatewayFeedStore } from '@agentic-obs/data-layer';
/**
 * Thin HTTP/SSE adapter — delegates all business logic to DashboardService.
 */
export declare function handleChatMessage(req: Request, res: Response, dashboardId: string, message: string, timeRange: {
    start?: string;
    end?: string;
    timezone?: string;
} | undefined, store: IGatewayDashboardStore, conversationStore: IConversationStore, investigationReportStore: IInvestigationReportRepository, alertRuleStore: IAlertRuleRepository, investigationStore?: IGatewayInvestigationStore, feedStore?: IGatewayFeedStore): Promise<void>;
//# sourceMappingURL=chat-handler.d.ts.map