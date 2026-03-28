export class ChangeEventAdapter {
    // ... 前面部分未在图中显示
    ingestWebhook(event) {
        // ... (省略了具体的转换逻辑)
        if (!change)
            return null;
        this.store.add(change);
        this.enforceMaxEvents();
        return change;
    }

    /**
     * Directly ingest a pre-normalized Change object (e.g. from an API poll).
     */
    ingestChange(change) {
        this.store.add(change);
        this.enforceMaxEvents();
    }

    // -- Utility --
    enforceMaxEvents() {
        // Simple eviction: if we blow past maxEvents, the store keeps all events for now.
        // A production store would use a ring buffer or TTL-based eviction.
        // For in-memory MVP this is a no-op safety valve.
        if (this.store.size > this.maxEvents) {
            // Re-initialize: keep only the most recent maxEvents
            // This is acceptable for the in-memory MVP
        }
    }

    /** Expose the underlying store for integration use (e.g. registering webhook routes). */
    get changeStore() {
        return this.store;
    }
}
//# sourceMappingURL=adapter.js.map