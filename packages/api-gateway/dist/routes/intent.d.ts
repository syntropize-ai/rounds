import { Router } from 'express';
import type { IGatewayDashboardStore } from '../repositories/types.js';
import type { IAlertRuleRepository, IGatewayInvestigationStore, IGatewayFeedStore, IInvestigationReportRepository } from '@agentic-obs/data-layer';
export interface IntentRouterDeps {
    dashboardStore: IGatewayDashboardStore;
    alertRuleStore?: IAlertRuleRepository;
    investigationStore?: IGatewayInvestigationStore;
    feedStore?: IGatewayFeedStore;
    reportStore?: IInvestigationReportRepository;
}
export declare function createIntentRouter(deps: IntentRouterDeps): Router;
//# sourceMappingURL=intent.d.ts.map