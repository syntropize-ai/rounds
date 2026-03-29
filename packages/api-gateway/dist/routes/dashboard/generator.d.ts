import type { IGatewayDashboardStore } from '../../repositories/types.js';
import type { DashboardGenerator } from './router.js';
export declare class LiveDashboardGenerator implements DashboardGenerator {
    private readonly store;
    constructor(store: IGatewayDashboardStore);
    generate(dashboardId: string, prompt: string, userId: string): void;
    private execute;
    private research;
    private discoverMetrics;
    private generateDashboard;
}
//# sourceMappingURL=generator.d.ts.map
