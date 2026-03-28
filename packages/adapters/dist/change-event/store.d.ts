import type { Change } from '@agentic-obs/common';
import type { ChangeQuery } from './types.js';

export declare class ChangeEventStore {
    private readonly events;
    /** Append a single normalized Change to the store. */
    add(change: Change): void;
    /** Append multiple Change objects. */
    addAll(changes: Change[]): void;
    /**
     * Query changes matching the given criteria.
     * Results are sorted by timestamp descending (most recent first).
     */
    query(q: ChangeQuery): Change[];
    /** Return total number of stored events. */
    get size(): number;
    /** Clear all stored events (useful in tests). */
    clear(): void;
}
//# sourceMappingURL=store.d.ts.map