// @agentic-obs/guardrails - Safety guardrails
export class GuardChain {
    guards = [];
    add(guard) {
        this.guards.push(guard);
        return this;
    }
    async check(input, context) {
        for (const guard of this.guards) {
            const result = await guard.check(input, context);
            if (result.decision !== 'allow') {
                return result;
            }
        }
        return { decision: 'allow' };
    }
}
export * from './cost-guard/index.js';
export * from './query-guard/index.js';
export * from './confidence-guard/index.js';
export { ActionGuard } from './action-guard/index.js';
export * from './credential/index.js';
//# sourceMappingURL=index.js.map