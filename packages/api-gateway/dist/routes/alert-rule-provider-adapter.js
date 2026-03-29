/**
 * Bridges AlertRuleStore to the AlertRuleProvider interface expected by the evaluator.
 */
export class AlertRuleStoreProvider {
    store;
    constructor(store) {
        this.store = store;
    }
    getActiveRules() {
        return this.store.findAll().rules.filter(r => r.state !== 'disabled');
    }
    transition(id, newState, value) {
        return this.store.transition(id, newState, value);
    }
    markEvaluated(id) {
        this.store.update(id, { lastEvaluatedAt: new Date().toISOString() });
    }
}
//# sourceMappingURL=alert-rule-provider-adapter.js.map
