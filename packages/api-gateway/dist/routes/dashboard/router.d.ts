import type { Router as ExpressRouter } from 'express';
import type { IGatewayDashboardStore, IConversationStore, IInvestigationReportRepository, IAlertRuleRepository } from '@agentic-obs/data-layer';
export interface DashboardRouterDeps {
    store: IGatewayDashboardStore;
    conversationStore: IConversationStore;
    investigationReportStore: IInvestigationReportRepository;
    alertRuleStore: IAlertRuleRepository;
}
export declare function createDashboardRouter(deps: DashboardRouterDeps): ExpressRouter;
//# sourceMappingURL=router.d.ts.map