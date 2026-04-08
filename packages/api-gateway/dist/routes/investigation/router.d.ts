import { Router } from 'express';
import type { IGatewayInvestigationStore, IGatewayFeedStore, IGatewayShareStore, IInvestigationReportRepository } from '@agentic-obs/data-layer';
import type { OrchestratorRunner } from './orchestrator-runner.js';
export interface InvestigationRouterDeps {
    store: IGatewayInvestigationStore;
    feed: IGatewayFeedStore;
    orchestrator?: OrchestratorRunner;
    shareRepo: IGatewayShareStore;
    reportStore: IInvestigationReportRepository;
}
export declare function createInvestigationRouter(deps: InvestigationRouterDeps): Router;
export declare const openApiRouter: import("express-serve-static-core").Router;
//# sourceMappingURL=router.d.ts.map