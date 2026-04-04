import { DEFAULT_LLM_MODEL, type AlertRule } from '@agentic-obs/common';
import { defaultAlertRuleStore } from '@agentic-obs/data-layer';
import { AlertRuleAgent } from '@agentic-obs/agent-core';
import { getSetupConfig } from '../routes/setup.js';
import { createLlmGateway } from '../routes/llm-factory.js';
import { resolvePrometheusDatasource } from './dashboard-service.js';

export interface GenerateAlertRuleResult {
  rule: AlertRule;
}

export class AlertRuleService {
  /**
   * Generate an alert rule from a natural-language prompt using the LLM.
   * Pure business logic — no HTTP concepts.
   */
  async generateFromPrompt(prompt: string): Promise<GenerateAlertRuleResult> {
    const config = getSetupConfig();
    if (!config.llm) {
      throw new Error('LLM not configured - complete Setup Wizard first');
    }

    const gateway = createLlmGateway(config.llm);
    const model = config.llm.model || DEFAULT_LLM_MODEL;

    const prom = resolvePrometheusDatasource(config.datasources);
    const prometheusUrl = prom?.url;
    const prometheusHeaders = prom?.headers ?? {};

    const agent = new AlertRuleAgent({ gateway, model, prometheusUrl, prometheusHeaders });
    const result = await agent.generate(prompt);
    const generated = result.rule;

    const rule = defaultAlertRuleStore.create({
      name: generated.name,
      description: generated.description,
      originalPrompt: prompt,
      condition: generated.condition,
      evaluationIntervalSec: generated.evaluationIntervalSec,
      severity: generated.severity,
      labels: generated.labels,
      createdBy: 'llm',
      notificationPolicyId: undefined,
      autoInvestigate: generated.autoInvestigate,
    } as unknown as Omit<AlertRule, 'id' | 'createdAt' | 'updatedAt' | 'fireCount' | 'state' | 'stateChangedAt'>);

    return { rule };
  }
}
