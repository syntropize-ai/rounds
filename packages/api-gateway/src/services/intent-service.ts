import { createLogger, DEFAULT_LLM_MODEL, type AlertRule } from '@agentic-obs/common';

const log = createLogger('intent-service');
import { defaultAlertRuleStore } from '@agentic-obs/data-layer';
import { AlertRuleAgent } from '@agentic-obs/agent-core';
import type { IGatewayDashboardStore } from '../repositories/types.js';
import { getSetupConfig } from '../routes/setup.js';
import { createLlmGateway } from '../routes/llm-factory.js';
import { resolvePrometheusDatasource } from './dashboard-service.js';

export type IntentType = 'alert' | 'dashboard' | 'investigate';

export interface IntentAlertResult {
  intent: 'alert';
  alertRuleId: string;
  summary: string;
  navigate: string;
}

export interface IntentDashboardResult {
  intent: 'dashboard' | 'investigate';
  dashboardId: string;
  navigate: string;
}

export type IntentResult = IntentAlertResult | IntentDashboardResult;

export interface IntentProgress {
  type: 'thinking' | 'intent';
  data: unknown;
}

export class IntentService {
  constructor(private dashboardStore: IGatewayDashboardStore) {}

  /**
   * Classify the user's message into an intent using the LLM.
   * Returns one of: 'alert', 'dashboard', 'investigate'.
   */
  async classifyIntent(message: string): Promise<IntentType> {
    const config = getSetupConfig();
    if (!config.llm) {
      throw new Error('LLM not configured');
    }

    const gateway = createLlmGateway(config.llm);
    const model = config.llm.model || DEFAULT_LLM_MODEL;

    const classifyResp = await gateway.complete([
      {
        role: 'system',
        content:
          `You are an intent classifier for an observability platform. Classify the user's message into exactly one intent.\n\n`
          + `Return JSON: { "intent": "<intent>" }\n\n`
          + `Possible intents:\n`
          + `- "alert": The user wants to set up an alert, be notified, or monitor a condition with a threshold.\n`
          + `- "dashboard": The user wants to create or view a monitoring dashboard to visualize metrics.\n`
          + `- "investigate": The user is asking about a problem, wants to diagnose an issue, or is troubleshooting.\n\n`
          + `Classify based on the user's actual goal, not surface-level keywords.`,
      },
      { role: 'user', content: message },
    ], {
      model,
      maxTokens: 64,
      temperature: 0,
      responseFormat: 'json',
    });

    const cleaned = classifyResp.content.replace(/```json\n?/g, '').replace(/```/g, '').trim();
    try {
      const parsed = JSON.parse(cleaned) as { intent?: string };
      return (parsed.intent as IntentType) ?? 'dashboard';
    } catch {
      return 'dashboard';
    }
  }

  /**
   * Execute an alert intent: generate an alert rule from the message via LLM.
   */
  async executeAlertIntent(message: string): Promise<IntentAlertResult> {
    const config = getSetupConfig();
    if (!config.llm) {
      throw new Error('LLM not configured');
    }

    const gateway = createLlmGateway(config.llm);
    const model = config.llm.model || DEFAULT_LLM_MODEL;

    const prom = resolvePrometheusDatasource(config.datasources);
    const prometheusUrl = prom?.url;
    const prometheusHeaders = prom?.headers ?? {};

    const agent = new AlertRuleAgent({ gateway, model, prometheusUrl, prometheusHeaders });
    const generated = await agent.generate(message);

    const rule = defaultAlertRuleStore.create({
      name: generated.name,
      description: generated.description,
      originalPrompt: message,
      condition: generated.condition,
      evaluationIntervalSec: generated.evaluationIntervalSec,
      severity: generated.severity,
      labels: generated.labels,
      createdBy: 'llm',
    } as any);

    return {
      intent: 'alert',
      alertRuleId: rule.id,
      summary: `Alert "${rule.name}" created: ${rule.condition.query} ${rule.condition.operator} ${rule.condition.threshold}`,
      navigate: '/alerts',
    };
  }

  /**
   * Execute a dashboard/investigate intent: create a workspace.
   */
  async executeDashboardIntent(message: string, intent: 'dashboard' | 'investigate'): Promise<IntentDashboardResult> {
    const title = intent === 'investigate' ? 'Investigation' : 'Untitled Dashboard';

    const dashboard = await this.dashboardStore.create({
      title,
      description: '',
      prompt: message,
      userId: 'anonymous',
      datasourceIds: [],
      useExistingMetrics: true,
    });

    return {
      intent,
      dashboardId: dashboard.id,
      navigate: `/dashboards/${dashboard.id}`,
    };
  }

  /**
   * Full intent flow: classify then execute.
   * Calls onProgress for streaming updates.
   */
  async processMessage(
    message: string,
    onProgress: (event: IntentProgress) => void,
  ): Promise<IntentResult> {
    onProgress({ type: 'thinking', data: { content: 'Understanding your request...' } });

    const intent = await this.classifyIntent(message);
    log.info({ message: message.slice(0, 80), intent }, 'classified intent');
    onProgress({ type: 'intent', data: { intent } });

    if (intent === 'alert') {
      onProgress({ type: 'thinking', data: { content: 'Creating alert rule...' } });
      const result = await this.executeAlertIntent(message);
      return result;
    } else {
      onProgress({
        type: 'thinking',
        data: {
          content: intent === 'investigate'
            ? 'Starting investigation...'
            : 'Setting up dashboard workspace...',
        },
      });
      return this.executeDashboardIntent(message, intent);
    }
  }
}
