import type { PostMortemReport } from '@agentic-obs/agent-core';
/**
 * Simple in-memory store for generated post-mortem reports, keyed by incidentId.
 * One report per incident; re-generating overwrites the previous report.
 */
export declare class PostMortemStore {
    private readonly reports;
    set(incidentId: string, report: PostMortemReport): void;
    get(incidentId: string): PostMortemReport | undefined;
    has(incidentId: string): boolean;
    get size(): number;
}
export declare const postMortemStore: PostMortemStore;
//# sourceMappingURL=post-mortem-store.d.ts.map
