import { Router } from 'express';
import type { IAlertRuleRepository, IGatewayInvestigationStore, IGatewayFeedStore, IInvestigationReportRepository } from '@agentic-obs/data-layer';
export interface AlertRulesRouterDeps {
    alertRuleStore?: IAlertRuleRepository;
    investigationStore?: IGatewayInvestigationStore;
    feedStore?: IGatewayFeedStore;
    reportStore?: IInvestigationReportRepository;
}
export declare function createAlertRulesRouter(deps?: AlertRulesRouterDeps): Router;
export declare const alertRulesRouter: Router;
//# sourceMappingURL=alert-rules.d.ts.map