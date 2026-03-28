// In-memory evidence store - append-only, queryable by hypothesis or investigation
export class EvidenceStore {
    items = new Map();

    add(evidence) {
        this.items.set(evidence.id, evidence);
    }

    addAll(items) {
        for (const item of items) {
            this.items.set(item.id, item);
        }
    }

    get(id) {
        return this.items.get(id);
    }

    getByHypothesis(hypothesisId) {
        return [...this.items.values()].filter((e) => e.hypothesisId === hypothesisId);
    }

    getByIds(ids) {
        return ids.flatMap((id) => {
            const e = this.items.get(id);
            return e ? [e] : [];
        });
    }

    list() {
        return [...this.items.values()];
    }

    get size() {
        return this.items.size;
    }

    clear() {
        this.items.clear();
    }
}
//# sourceMappingURL=store.js.map