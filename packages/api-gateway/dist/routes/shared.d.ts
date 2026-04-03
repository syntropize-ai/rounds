import { Router } from 'express';
import type { IShareRepository } from '@agentic-obs/data-layer';
import type { IGatewayInvestigationStore } from '../repositories/types.js';
export declare const defaultShareRepo: IShareRepository;
export interface SharedRouterDeps {
    shareRepo?: IShareRepository;
    investigationStore?: IGatewayInvestigationStore;
}
export declare function createSharedRouter(deps?: SharedRouterDeps): Router;
export declare const sharedRouter: Router;
//# sourceMappingURL=shared.d.ts.map