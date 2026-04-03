import type { LLMGateway } from '@agentic-obs/llm-gateway';
import type { AlertCondition, AlertSeverity } from '@agentic-obs/common';
interface AlertRuleAgentDeps {
    gateway: LLMGateway;
    model: string;
    prometheusUrl: string | undefined;
    prometheusHeaders: Record<string, string>;
}
interface GeneratedAlertRule {
    name: string;
    description: string;
    condition: AlertCondition;
    evaluationIntervalSec: number;
    severity: AlertSeverity;
    labels: Record<string, string>;
    autoInvestigate: boolean;
}
export interface AlertRuleContext {
    dashboardId?: string;
    dashboardTitle?: string;
    /** PromQL queries already in use on the dashboard - the alert should use consistent queries */
    existingQueries?: string[];
    /** Dashboard variables (e.g. namespace, instance) */
    variables?: Array<{
        name: string;
        value?: string;
    }>;
}
export declare class AlertRuleAgent {
    private deps;
    constructor(deps: AlertRuleAgentDeps);
    generate(prompt: string, context?: AlertRuleContext): Promise<GeneratedAlertRule>;
}
export {};
//# sourceMappingURL=alert-rule-agent.d.ts.map