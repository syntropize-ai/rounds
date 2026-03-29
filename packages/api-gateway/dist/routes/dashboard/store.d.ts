import type { Dashboard, DashboardStatus, DashboardVariable, PanelConfig } from '@agentic-obs/common';
import type { IGatewayDashboardStore } from '../../repositories/types.js';
import type { Persistable } from '../../persistence.js';
export declare class DashboardStore implements IGatewayDashboardStore, Persistable {
    private readonly dashboards;
    private readonly maxCapacity;
    constructor(maxCapacity?: number);
    create(params: {
        title: string;
        description: string;
        prompt: string;
        userId: string;
        datasourceIds: string[];
        useExistingMetrics?: boolean;
        folder?: string;
    }): Dashboard;
    private _evictIfNeeded;
    findById(id: string): Dashboard | undefined;
    findAll(userId?: string): Dashboard[];
    update(id: string, patch: Partial<Pick<Dashboard, 'type' | 'title' | 'description' | 'panels' | 'variables' | 'refreshIntervalSec' | 'folder'>>): Dashboard | undefined;
    updateStatus(id: string, status: DashboardStatus, error?: string): Dashboard | undefined;
    updatePanels(id: string, panels: PanelConfig[]): Dashboard | undefined;
    updateVariables(id: string, variables: DashboardVariable[]): Dashboard | undefined;
    delete(id: string): boolean;
    get size(): number;
    clear(): void;
    toJSON(): unknown;
    loadJSON(data: unknown): void;
}
/** Module-level singleton */
export declare const defaultDashboardStore: DashboardStore;
//# sourceMappingURL=store.d.ts.map
