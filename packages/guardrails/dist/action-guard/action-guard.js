export class ActionGuard {
    rules;
    constructor(rules) {
        this.rules = rules;
    }
    evaluate(action) {
        for (const rule of this.rules) {
            if (!this.matchesRule(action, rule)) {
                continue;
            }
            if (rule.conditions) {
                const conditionResult = this.checkConditions(action, rule);
                if (conditionResult !== null) {
                    return conditionResult;
                }
            }
            return {
                effect: rule.effect,
                matchedRule: rule,
                reason: rule.description ?? `Matched rule: ${rule.id}`,
            };
        }
        return {
            effect: 'deny',
            reason: 'No matching policy rule (deny-by-default)',
        };
    }
    matchesRule(action, rule) {
        const { actionType, targetService, env } = rule.match;
        if (actionType !== undefined && actionType !== '*' && actionType !== action.type) {
            return false;
        }
        if (targetService !== undefined && targetService !== '*' && targetService !== action.targetService) {
            return false;
        }
        if (env !== undefined && env !== '*' && env !== action.env) {
            return false;
        }
        return true;
    }
    checkConditions(action, rule) {
        const conditions = rule.conditions;
        const params = action.params ?? {};
        if (conditions.maxReplicas !== undefined) {
            const replicas = params['replicas'];
            if (typeof replicas === 'number' && replicas > conditions.maxReplicas) {
                return {
                    effect: 'deny',
                    matchedRule: rule,
                    reason: `Replicas ${replicas} exceed maximum allowed ${conditions.maxReplicas}`,
                };
            }
        }
        if (conditions.allowedNamespaces !== undefined) {
            const namespace = params['namespace'];
            if (typeof namespace === 'string' && !conditions.allowedNamespaces.includes(namespace)) {
                return {
                    effect: 'deny',
                    matchedRule: rule,
                    reason: `Namespace "${namespace}" is not in the allowed list: ${conditions.allowedNamespaces.join(', ')}`,
                };
            }
        }
        if (conditions.timeWindow !== undefined) {
            const now = new Date();
            const currentMinutes = now.getHours() * 60 + now.getMinutes();
            const startMinutes = this.parseTime(conditions.timeWindow.start);
            const endMinutes = this.parseTime(conditions.timeWindow.end);
            const inWindow = startMinutes <= endMinutes
                ? currentMinutes >= startMinutes && currentMinutes <= endMinutes
                : currentMinutes >= startMinutes || currentMinutes <= endMinutes;
            if (!inWindow) {
                return {
                    effect: 'deny',
                    matchedRule: rule,
                    reason: `Action not allowed outside time window ${conditions.timeWindow.start}-${conditions.timeWindow.end}`,
                };
            }
        }
        return null;
    }
    parseTime(time) {
        const [hours, minutes] = time.split(':').map(Number);
        return (hours ?? 0) * 60 + (minutes ?? 0);
    }
}
//# sourceMappingURL=action-guard.js.map