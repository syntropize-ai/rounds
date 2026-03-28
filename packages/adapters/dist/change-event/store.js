// In-memory store for Change events with query by service + time range
export class ChangeEventStore {
    events = [];

    /** Append a single normalized Change to the store. */
    add(change) {
        this.events.push(change);
    }

    /** Append multiple Change objects. */
    addAll(changes) {
        this.events.push(...changes);
    }

    /**
     * Query changes matching the given criteria.
     * Results are sorted by timestamp descending (most recent first).
     */
    query(q) {
        const startMs = q.startTime.getTime();
        const endMs = q.endTime.getTime();
        const results = this.events.filter((c) => {
            const ts = new Date(c.timestamp).getTime();
            if (ts < startMs || ts > endMs)
                return false;
            if (q.serviceId && c.serviceId !== q.serviceId)
                return false;
            if (q.type && c.type !== q.type)
                return false;
            return true;
        });
        results.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
        return q.limit !== undefined ? results.slice(0, q.limit) : results;
    }

    /** Return total number of stored events. */
    get size() {
        return this.events.length;
    }

    /** Clear all stored events (useful in tests). */
    clear() {
        this.events.length = 0;
    }
}
//# sourceMappingURL=store.js.map