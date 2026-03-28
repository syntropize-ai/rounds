// ExecutionAgent - rule-based recommended action generator (Phase 0: suggest only)
import { DEFAULT_RULES, criticalNotifyRule } from './rules.js';

/**
 * @deprecated Rule-based fallback only. LLMExecutionAgent (execution-agent.ts) is the primary
 * execution path. This class should not be used for new integrations.
 */
export class ExecutionAgent {
    name = 'execution';
    rules;
    maxActions;

    constructor(options = {}) {
        this.rules = options.rules ?? DEFAULT_RULES;
        this.maxActions = options.maxActions ?? 5;
    }

    /**
     * Generate recommended actions from a StructuredConclusion.
     *
     * Phase 0 safety contract:
     * - All actions: status = 'proposed', never auto-execute.
     * - policyTag is set per rule: 'suggest' or 'approve_required' - never 'deny'.
     * - Refuted hypotheses produce no actions.
     * - Action types deduplicated (highest-confidence hypothesis wins).
     */
    async propose(input) {
        const actions = [];
        const seenTypes = new Set();
        const { conclusion, context } = input;

        // 1. Apply hypothesis-level rules from ranked hypotheses
        for (const ranked of conclusion.hypotheses) {
            if (actions.length >= this.maxActions)
                break;
            const { hypothesis } = ranked;
            if (hypothesis.status === 'refuted')
                continue;
            const evidence = [];
            for (const rule of this.rules) {
                if (actions.length >= this.maxActions)
                    break;
                if (!rule.matches(hypothesis, evidence))
                    continue;
                const action = rule.buildAction(hypothesis, evidence, context.entity);
                if (seenTypes.has(action.type))
                    continue;
                seenTypes.add(action.type);
                actions.push(action);
            }
        }

        // 2. Impact-level rule: critical severity → always notify oncall
        if (conclusion.impact.severity === 'critical' && !seenTypes.has('notify')) {
            const notifyHypothesis = conclusion.hypotheses[0]?.hypothesis;
            if (notifyHypothesis) {
                const notify = criticalNotifyRule.buildAction(notifyHypothesis, [], context.entity);
                actions.push(notify);
                seenTypes.add('notify');
            }
        }

        // 3. Pass through any actions already in conclusion.recommendedActions
        //    (from ExplanationAgent) that aren't duplicated
        for (const rec of conclusion.recommendedActions) {
            if (actions.length >= this.maxActions)
                break;
            if (seenTypes.has(rec.action.type))
                continue;
            seenTypes.add(rec.action.type);
            actions.push({ ...rec.action, status: 'proposed' });
        }

        const summary = this.buildSummary(actions, context.entity);
        return { actions, summary };
    }

    // -- Helpers -----------------------------------------------------------
    buildSummary(actions, entity) {
        if (actions.length === 0) {
            return `No actionable recommendations generated for ${entity}.`;
        }
        const descriptions = actions.map((a) => `${a.type} (${a.policyTag})`).join(', ');
        return `Generated ${actions.length} recommended action(s) for ${entity}: ${descriptions}. ` +
            `All actions require operator review - none will auto-execute.`;
    }
}
//# sourceMappingURL=agent.js.map