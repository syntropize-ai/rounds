export interface ProviderCapabilities {
  /** Does the provider support native tool_use API? Required to use ANY tools. */
  supportsNativeTools: boolean;
  /**
   * Does this (provider, model) support extended thinking / reasoning budgets?
   * When false, the gateway silently drops the `thinking` option instead of
   * sending an unsupported parameter.
   */
  supportsThinking: boolean;
  /** Can the model emit multiple tool_use blocks in a single turn? */
  supportsParallelTools: boolean;
}

// Per-provider model-name predicates for thinking support. Kept narrow on
// purpose — when a new model family lands, add the regex here rather than
// guessing from prefix patterns elsewhere in the code.

function anthropicSupportsThinking(model: string): boolean {
  // Claude 3.7 Sonnet and the entire 4.x line (opus/sonnet/haiku 4, 4.5, 4.6, 4.7…)
  if (/^claude-3-7-/.test(model)) return true;
  if (/^claude-(opus|sonnet|haiku)-([4-9]|\d{2,})/.test(model)) return true;
  return false;
}

function openaiSupportsReasoning(model: string): boolean {
  // o1/o3/o4 reasoning families and the gpt-5.x line. gpt-4o et al do NOT
  // accept reasoning_effort even though they technically have function calls.
  if (/^o[1-9](-|$)/.test(model)) return true;
  if (/^gpt-5/.test(model)) return true;
  return false;
}

function geminiSupportsThinking(model: string): boolean {
  // 2.5 introduced thinkingConfig; 3.x carries it forward.
  if (/^gemini-2\.5/.test(model)) return true;
  if (/^gemini-[3-9]/.test(model)) return true;
  return false;
}

/**
 * Capability detection by (providerName, model).
 * Conservative defaults: when in doubt, return supportsNativeTools=false
 * so the gateway throws a friendly error instead of failing silently.
 */
export function getCapabilities(
  providerName: 'anthropic' | 'openai' | 'gemini' | 'ollama' | 'mock',
  model: string,
): ProviderCapabilities {
  switch (providerName) {
    case 'anthropic':
      return {
        supportsNativeTools: true,
        supportsThinking: anthropicSupportsThinking(model),
        supportsParallelTools: true,
      };
    case 'openai':
      return {
        supportsNativeTools: true,
        supportsThinking: openaiSupportsReasoning(model),
        supportsParallelTools: true,
      };
    case 'gemini':
      return {
        supportsNativeTools: true,
        supportsThinking: geminiSupportsThinking(model),
        supportsParallelTools: false,
      };
    case 'ollama':
      // Per-model — runtime probe handles tool capability. Thinking is model
      // dependent (Qwen3-Thinking, QwQ have it) and we can't tell without a
      // probe; keep false so we don't send an unsupported flag.
      return { supportsNativeTools: true, supportsThinking: false, supportsParallelTools: false };
    case 'mock':
      return { supportsNativeTools: true, supportsThinking: false, supportsParallelTools: true };
  }
}

/**
 * Map portable effort enum to a token budget. Used by Anthropic and Gemini
 * which expect a number; OpenAI consumes the enum directly.
 */
export function effortToBudgetTokens(effort: 'low' | 'medium' | 'high'): number {
  switch (effort) {
    case 'low':
      return 1024;
    case 'medium':
      return 4096;
    case 'high':
      return 16384;
  }
}

/**
 * Thrown when a configured provider/model can't do what the agent needs.
 * Surface to the user as a setup error, not a runtime crash.
 */
export class ProviderCapabilityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProviderCapabilityError';
  }
}
