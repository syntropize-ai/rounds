import type { StructuredIntent } from '@agentic-obs/common';
import type { LLMGateway } from '@agentic-obs/llm-gateway';
import type { IntentInput } from './types.js';
import { INTENT_SYSTEM_PROMPT, buildPromptMessage } from './prompts.js';
import { parseAndValidate, IntentValidationError } from './schema.js';

export interface IntentAgentOptions {
  model?: string;
  temperature?: number;
  maxTokens?: number;
}

const DEFAULT_OPTIONS: Required<IntentAgentOptions> = {
  model: 'gpt-4o-mini',
  temperature: 0,
  maxTokens: 512,
};

export class IntentAgent {
  readonly name = 'intent';

  private readonly gateway: LLMGateway;
  private readonly options: Required<IntentAgentOptions>;

  constructor(gateway: LLMGateway, options: IntentAgentOptions = {}) {
    this.gateway = gateway;
    this.options = { ...DEFAULT_OPTIONS, ...options };
  }

  /**
   * Parse a natural-language message into a StructuredIntent.
   * Throws on LLM failure or invalid response schema.
   */
  async parse(input: IntentInput): Promise<StructuredIntent> {
    const now = new Date().toISOString();

    const response = await this.gateway.complete([
      { role: 'system', content: INTENT_SYSTEM_PROMPT },
      { role: 'user', content: buildPromptMessage(input.message, now) },
    ], {
      model: this.options.model,
      temperature: this.options.temperature,
      maxTokens: this.options.maxTokens,
      responseFormat: 'json',
    });

    return parseAndValidate(response.content);
  }

  /**
   * Like parse(), but returns a fallback intent instead of throwing on error.
   * Useful when a degraded response is preferable to a hard failure.
   */
  async safeParse(input: IntentInput): Promise<StructuredIntent | null> {
    try {
      return await this.parse(input);
    } catch (err) {
      if (err instanceof IntentValidationError) {
        return null;
      }
      throw err;
    }
  }
}
