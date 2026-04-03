import type { SavedInvestigationReport } from '@agentic-obs/common';
import type { Persistable } from '../../persistence.js';
export declare class InvestigationReportStore implements Persistable {
    private readonly reports;
    save(report: SavedInvestigationReport): void;
    findById(id: string): SavedInvestigationReport | undefined;
    findAll(): SavedInvestigationReport[];
    findByDashboard(dashboardId: string): SavedInvestigationReport[];
    delete(id: string): boolean;
    toJSON(): unknown;
    loadJSON(data: unknown): void;
}
/** Module-level singleton */
export declare const defaultInvestigationReportStore: InvestigationReportStore;
//# sourceMappingURL=investigation-report-store.d.ts.map