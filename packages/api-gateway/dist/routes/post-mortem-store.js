/**
 * Simple in-memory store for generated post-mortem reports, keyed by incidentId.
 * One report per incident; re-generating overwrites the previous report.
 */
export class PostMortemStore {
    reports = new Map();
    set(incidentId, report) {
        this.reports.set(incidentId, report);
    }
    get(incidentId) {
        return this.reports.get(incidentId);
    }
    has(incidentId) {
        return this.reports.has(incidentId);
    }
    get size() {
        return this.reports.size;
    }
}
export const postMortemStore = new PostMortemStore();
//# sourceMappingURL=post-mortem-store.js.map