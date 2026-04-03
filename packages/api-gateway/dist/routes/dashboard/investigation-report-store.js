// In-memory store for saved investigation reports
import { markDirty } from '../../persistence.js';
export class InvestigationReportStore {
    reports = new Map();
    save(report) {
        this.reports.set(report.id, report);
        markDirty();
    }
    findById(id) {
        return this.reports.get(id);
    }
    findAll() {
        return [...this.reports.values()];
    }
    findByDashboard(dashboardId) {
        return [...this.reports.values()].filter((r) => r.dashboardId === dashboardId);
    }
    delete(id) {
        const result = this.reports.delete(id);
        if (result)
            markDirty();
        return result;
    }
    toJSON() {
        return [...this.reports.values()];
    }
    loadJSON(data) {
        if (!Array.isArray(data))
            return;
        for (const r of data) {
            if (r.id)
                this.reports.set(r.id, r);
        }
    }
}
/** Module-level singleton */
export const defaultInvestigationReportStore = new InvestigationReportStore();
//# sourceMappingURL=investigation-report-store.js.map