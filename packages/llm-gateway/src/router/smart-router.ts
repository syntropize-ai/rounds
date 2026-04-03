// SmartModelRouter — LLM-driven model selection for task routing
//
// LLM-first principle: a lightweight classifier LLM evaluates task complexity
// and recommends the most appropriate model. Rule-based token counts are only used
// as a fallback when the LLM classifier is unavailable or fails (it is only used
// for cost estimation).

import type { LLMProvider } from '../types.js';

// — Public types

export interface ModelConfig {
  id: string;
  provider: string;
  costPer1kTokens: number;
  latencyP50Ms: number;
  capabilities: string[];
}

export interface TaskDescription {
  type: string;
  complexity: 'low' | 'medium' | 'high' | 'unknown';
  tokenEstimate?: number;
  contextTokens?: number;
  costBudgetUsd?: number;
}

export interface ModelSelection {
  model: string;
  reasoning: string;
  estimatedCost: number;
  estimatedLatency: number;
}

export interface SmartRouterConfig {
  models: ModelConfig[];
  classifierLlm?: LLMProvider;
  /** Model ID to use for the classifier LLM (e.g., 'claude-sonnet-4-6'). Required because provider.complete needs the provider name. */
  classifierModel?: string;
  /** Default model ID to use when LLM classifier is unavailable. Defaults to the first model in the list. */
  defaultModel?: string;
}

// — LLM response shape

interface LLMRoutingResponse {
  model?: string;
  reasoning?: unknown;
}

// — SmartModelRouter

export class SmartModelRouter {
  private readonly models: ModelConfig[];
  private readonly classifierLlm: LLMProvider | undefined;
  private readonly classifierModel: string;
  private readonly defaultModel: string;

  constructor(config: SmartRouterConfig) {
    if (config.models.length === 0) {
      throw new Error('SmartModelRouter requires at least one model configuration');
    }

    this.models = config.models;
    this.classifierLlm = config.classifierLlm;
    this.classifierModel = config.classifierModel ?? 'claude-sonnet-4-6';
    this.defaultModel = config.defaultModel ?? config.models[0]!.id;
  }

  /**
   * Route a task to the most appropriate model.
   *
   * Primary path (LLM-driven): ask the classifier LLM to evaluate the task and
   * recommend a model, with reasoning.
   *
   * Fallback: if the LLM classifier is unavailable, uses the configured defaultModel
   * (or the first model in the list). This is not a rule-engine — it simply
   * uses the user-configured default when the LLM cannot classify.
   */
  async routeWithLlm(task: TaskDescription): Promise<ModelSelection> {
    if (!this.classifierLlm) {
      return this.routeWithFallback(task);
    }

    // -- LLM-driven routing
    const modelList = this.models;

    const prompt = `
Given this task, what model is most appropriate?

${modelList.map((m) => `- id:${m.id} (${m.provider}) maxTokens=${m.capabilities.join(',')} latencyP50=${m.latencyP50Ms}ms costPer1k=${m.costPer1kTokens} capabilities=${m.capabilities.join(',')} `).join('\n')}

Task:
- type: ${task.type}
- complexity: ${task.complexity}
- tokenEstimate: ${task.tokenEstimate}
- contextTokens: ${task.contextTokens}
${task.costBudgetUsd !== undefined ? `- costBudgetUsd: ${task.costBudgetUsd}` : ''}

Consider complexity (more powerful reasoning) vs cost vs simple extraction (should be balanced (lowest)).
Choose with high skill only if truly required: "reasoning", "creativity", "analysis".

Respond ONLY as JSON: { "model": "<model_id>", "reasoning": "<1 sentence>" }`;

    const response = await this.classifierLlm.complete(
      [{ role: 'user', content: prompt }],
      { model: this.classifierModel, temperature: 0, maxTokens: 256, responseFormat: 'json' },
    );

    const parsed = this.parseLlmResponse(response.content);
    const selectedId = parsed.model;
    const reasoning = typeof parsed.reasoning === 'string' ? parsed.reasoning : `LLM selected ${selectedId}`;

    const model = this.models.find((m) => m.id === selectedId) ?? this.models[0]!;

    return {
      model: model.id,
      reasoning: reasoning ?? `LLM selected ${model.id}`,
      estimatedCost: this.estimateCost(model, task.tokenEstimate),
      estimatedLatency: model.latencyP50Ms,
    };
  }

  private parseLlmResponse(raw: string): LLMRoutingResponse {
    const trimmed = raw.trim().replace(/```json\n?/g, '').replace(/```/g, '').trim();
    try {
      return JSON.parse(trimmed) as LLMRoutingResponse;
    } catch {
      return {};
    }
  }

  routeWithFallback(task: TaskDescription): ModelSelection {
    const model = this.models.find((m) => m.id === this.defaultModel) ?? this.models[0]!;

    return {
      model: model.id,
      reasoning: 'LLM classifier unavailable, using configured default model',
      estimatedCost: this.estimateCost(model, task.tokenEstimate),
      estimatedLatency: model.latencyP50Ms,
    };
  }

  private estimateCost(model: ModelConfig, taskEstimate?: number): number {
    return ((taskEstimate ?? 1_000) / 1_000) * model.costPer1kTokens;
  }
}
