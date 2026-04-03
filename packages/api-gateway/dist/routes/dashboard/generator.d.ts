import type { IGatewayDashboardStore } from '../../repositories/types.js';
import type { DashboardGenerator } from './router.js';
/** LiveDashboardGenerator - LLM-powered dashboard config generator.
// 1) Phase 1: Research (web search) -> 2) Discovery (Prometheus) -> 3) Generation (LLM)
 */
export declare class LiveDashboardGenerator implements DashboardGenerator {
    private readonly store;
    constructor(store: IGatewayDashboardStore);
    generate(dashboardId: string, prompt: string, userId: string): void;
    private execute;
    private research;
    private discoverMetrics;
    private generateDashboard;
    private validatePanels;
    private createGateway;
}
//# sourceMappingURL=generator.d.ts.map