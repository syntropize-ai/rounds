import { Router } from 'express';
import type { OrchestratorRunner } from './orchestrator-runner.js';
import type { IShareRepository } from '@agentic-obs/data-layer';
import type { IGatewayInvestigationStore, IGatewayFeedStore } from '../../repositories/types.js';
export interface InvestigationRouterDeps {
    store?: IGatewayInvestigationStore;
    feed?: IGatewayFeedStore;
    orchestrator?: OrchestratorRunner;
    shareRepo?: IShareRepository;
}
export declare function createInvestigationRouter(deps?: InvestigationRouterDeps): Router;
/** Default router instance using the module-level store */
export declare const investigationRouter: Router;
export declare const openApiRouter: import('express-serve-static-core').Router;
//# sourceMappingURL=router.d.ts.map
