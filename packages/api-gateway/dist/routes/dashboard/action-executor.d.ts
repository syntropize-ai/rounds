import type { DashboardAction, DashboardSseEvent } from '@agentic-obs/common';
import type { IGatewayDashboardStore } from '../../repositories/types.js';
export declare class ActionExecutor {
    private store;
    private sendEvent;
    constructor(store: IGatewayDashboardStore, sendEvent: (event: DashboardSseEvent) => void);
    execute(dashboardId: string, actions: DashboardAction[]): Promise<void>;
    private applyAction;
}
//# sourceMappingURL=action-executor.d.ts.map