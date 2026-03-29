import { Router } from 'express';
import type { IGatewayDashboardStore, IConversationStore } from '../../repositories/types.js';
export interface DashboardGenerator {
    generate(dashboardId: string, prompt: string, userId: string): void;
}
export interface DashboardRouterDeps {
    store?: IGatewayDashboardStore;
    generator?: DashboardGenerator;
    conversationStore?: IConversationStore;
}
export declare function createDashboardRouter(deps?: DashboardRouterDeps): Router;
/** Default router instance using the module-level store */
export declare const dashboardRouter: Router;
//# sourceMappingURL=router.d.ts.map
