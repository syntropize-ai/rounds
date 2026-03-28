// ExecutionAgent - rule-based recommended action generator (Phase 0: suggest only)
import { DEFAULT_RULES, criticalNotifyRule } from './rules.js';
import type { ActionRule, ExecutionInput, ExecutionOutput } from './types.js';

/**
 * @deprecated Rule-based fallback only. LLMExecutionAgent (execution-agent.ts) is the primary
 * execution path. This class should not be used for new integrations.
 */
export class ExecutionAgent {
  readonly name = 'execution';
  private readonly rules: ActionRule[];
  private readonly maxActions: number;

  constructor(options: { rules?: ActionRule[]; maxActions?: number } = {}) {
    this.rules = options.rules ?? DEFAULT_RULES;
    this.maxActions = options.maxActions ?? 5;
  }

  async propose(input: ExecutionInput): Promise<ExecutionOutput> {
    const actions = [];
    const seenTypes = new Set<string>();
    const { conclusion, context } = input;

    for (const ranked of conclusion.hypotheses) {
      if (actions.length >= this.maxActions) break;
      const { hypothesis } = ranked;
      if (hypothesis.status === 'refuted') continue;
      const evidence = [];
      for (const rule of this.rules) {
        if (actions.length >= this.maxActions) break;
        if (!rule.matches(hypothesis, evidence)) continue;
        const action = rule.buildAction(hypothesis, evidence, context.entity);
        if (seenTypes.has(action.type)) continue;
        seenTypes.add(action.type);
        actions.push(action);
      }
    }

    if (conclusion.impact.severity === 'critical' && !seenTypes.has('notify')) {
      const notifyHypothesis = conclusion.hypotheses[0]?.hypothesis;
      if (notifyHypothesis) {
        const notify = criticalNotifyRule.buildAction(notifyHypothesis, [], context.entity);
        actions.push(notify);
      }
    }

    for (const rec of conclusion.recommendedActions) {
      if (actions.length >= this.maxActions) break;
      if (seenTypes.has(rec.action.type)) continue;
      seenTypes.add(rec.action.type);
      actions.push({ ...rec.action, status: 'proposed' });
    }

    const summary = this.buildSummary(actions, context.entity);
    return { actions, summary };
  }

  private buildSummary(actions: { type: string; policyTag?: string }[], entity: string): string {
    if (actions.length === 0) {
      return `No actionable recommendations generated for ${entity}.`;
    }
    const descriptions = actions.map((a) => `${a.type} (${a.policyTag})`).join(', ');
    return `Generated ${actions.length} recommended action(s) for ${entity}: ${descriptions}. All actions require operator review - none will auto-execute.`;
  }
}
