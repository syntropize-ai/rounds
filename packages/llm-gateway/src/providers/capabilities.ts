export interface ProviderCapabilities {
  /** Does the provider support native tool_use API? Required to use ANY tools. */
  supportsNativeTools: boolean;
  /**
   * Does the provider support extended thinking / reasoning budgets?
   * Wired in PR-B. Declare here so the field exists, set false everywhere now.
   */
  supportsThinking: boolean;
  /** Can the model emit multiple tool_use blocks in a single turn? */
  supportsParallelTools: boolean;
}

/**
 * Capability detection by (providerName, model).
 * Conservative defaults: when in doubt, return supportsNativeTools=false
 * so the gateway throws a friendly error instead of failing silently.
 */
export function getCapabilities(
  providerName: 'anthropic' | 'openai' | 'gemini' | 'ollama' | 'mock',
  _model: string,
): ProviderCapabilities {
  switch (providerName) {
    case 'anthropic':
      // All Claude 3.x and 4.x support tools; thinking on 3.7+
      return { supportsNativeTools: true, supportsThinking: false, supportsParallelTools: true };
    case 'openai':
      // GPT-3.5+ and GPT-4 series all have tools; o1/o3 too
      return { supportsNativeTools: true, supportsThinking: false, supportsParallelTools: true };
    case 'gemini':
      // 1.5+ has tools
      return { supportsNativeTools: true, supportsThinking: false, supportsParallelTools: false };
    case 'ollama':
      // Per-model — Team E does runtime probe via /api/show. Default true; the
      // provider itself throws at construction time if the probe fails.
      return { supportsNativeTools: true, supportsThinking: false, supportsParallelTools: false };
    case 'mock':
      return { supportsNativeTools: true, supportsThinking: false, supportsParallelTools: true };
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
