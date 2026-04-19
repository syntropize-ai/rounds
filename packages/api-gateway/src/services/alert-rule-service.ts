import { DEFAULT_LLM_MODEL, type AlertRule } from '@agentic-obs/common';
import type { IAlertRuleRepository } from '@agentic-obs/data-layer';
import { AlertRuleAgent } from '@agentic-obs/agent-core';
import { PrometheusMetricsAdapter } from '@agentic-obs/adapters';
import { createLlmGateway } from '../routes/llm-factory.js';
import { resolvePrometheusDatasource } from './dashboard-service.js';
import type { SetupConfigService } from './setup-config-service.js';

export interface GenerateAlertRuleResult {
  rule: AlertRule;
}

export class AlertRuleService {
  constructor(
    private readonly store: IAlertRuleRepository,
    private readonly setupConfig: SetupConfigService,
  ) {}

  /**
   * Generate an alert rule from a natural-language prompt using the LLM.
   * Pure business logic — no HTTP concepts.
   */
  async generateFromPrompt(prompt: string): Promise<GenerateAlertRuleResult> {
    const llm = await this.setupConfig.getLlm();
    if (!llm) {
      throw new Error('LLM not configured - complete Setup Wizard first');
    }
    const datasources = await this.setupConfig.listDatasources();

    const gateway = createLlmGateway(llm);
    const model = llm.model || DEFAULT_LLM_MODEL;

    const prom = resolvePrometheusDatasource(datasources);
    const metrics = prom ? new PrometheusMetricsAdapter(prom.url, prom.headers) : undefined;

    const agent = new AlertRuleAgent({ gateway, model, metrics });
    const result = await agent.generate(prompt);
    const generated = result.rule;

    type AlertRuleCreateInput = Omit<AlertRule, 'id' | 'createdAt' | 'updatedAt' | 'fireCount' | 'state' | 'stateChangedAt'>;
    const createInput: AlertRuleCreateInput = {
      name: generated.name,
      description: generated.description,
      originalPrompt: prompt,
      condition: generated.condition,
      evaluationIntervalSec: generated.evaluationIntervalSec,
      severity: generated.severity,
      labels: generated.labels,
      createdBy: 'llm',
      notificationPolicyId: undefined,
    };
    const rule = await this.store.create(createInput);

    return { rule };
  }
}
