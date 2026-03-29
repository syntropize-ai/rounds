import type { AlertRuleProvider } from '@agentic-obs/agent-core';
import type { AlertRule, AlertRuleState } from '@agentic-obs/common';
import type { AlertRuleStore } from './alert-rule-store.js';
/**
 * Bridges AlertRuleStore to the AlertRuleProvider interface expected by the evaluator.
 */
export declare class AlertRuleStoreProvider implements AlertRuleProvider {
    private readonly store;
    constructor(store: AlertRuleStore);
    getActiveRules(): AlertRule[];
    transition(id: string, newState: AlertRuleState, value?: number): AlertRule | undefined;
    markEvaluated(id: string): void;
}
//# sourceMappingURL=alert-rule-provider-adapter.d.ts.map
