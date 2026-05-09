import { DEFAULT_LLM_MODEL, type AlertOperator, type AlertRule } from '@agentic-obs/common';
import type { IAlertRuleRepository } from '@agentic-obs/data-layer';
import { AlertRuleAgent } from '@agentic-obs/agent-core';
import { PrometheusMetricsAdapter } from '@agentic-obs/adapters';
import { createLlmGateway } from '../routes/llm-factory.js';
import { resolvePrometheusDatasource } from './dashboard-service.js';
import type { SetupConfigService } from './setup-config-service.js';
import {
  previewAlertCondition,
  type PreviewAlertResult,
} from './alert-evaluator-service.js';

export interface PreviewAlertRuleInput {
  query: string;
  operator: AlertOperator;
  threshold: number;
  lookbackHours?: number;
  /** Reserved — explicit datasource override; resolves to default Prom otherwise. */
  datasourceId?: string;
}

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
  async generateFromPrompt(prompt: string, orgId: string): Promise<GenerateAlertRuleResult> {
    const llm = await this.setupConfig.getLlm();
    if (!llm) {
      throw new Error('LLM not configured - complete Setup Wizard first');
    }
    const datasources = await this.setupConfig.listDatasources({ orgId });

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
      workspaceId: orgId,
      createdBy: 'llm',
      notificationPolicyId: undefined,
    };
    const rule = await this.store.create(createInput);

    return { rule };
  }

  /**
   * Backtest an alert condition against the current metrics datasource over
   * `lookbackHours` (default 24). Resolves the default Prometheus datasource
   * for the org; returns a structured `missing_capability` payload when no
   * metrics datasource is configured. Never fabricates data.
   */
  async previewCondition(
    input: PreviewAlertRuleInput,
    orgId: string,
  ): Promise<PreviewAlertResult> {
    const datasources = await this.setupConfig.listDatasources({ orgId });
    const prom = resolvePrometheusDatasource(datasources);
    if (!prom) {
      return { kind: 'missing_capability', reason: 'no_metrics_datasource' };
    }
    const metrics = new PrometheusMetricsAdapter(prom.url, prom.headers);
    return previewAlertCondition(metrics, {
      query: input.query,
      operator: input.operator,
      threshold: input.threshold,
      lookbackHours: input.lookbackHours,
    });
  }
}
