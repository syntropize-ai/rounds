export type SamplingParam = 'temperature' | 'top_p' | 'top_k';

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
  /**
   * Sampling knobs the model accepts on the wire. Models outside this set
   * MUST be filtered out before sending — newer Anthropic models (Opus 4.7+)
   * deprecated `temperature`/`top_p`/`top_k` and Bedrock returns 400
   * `ValidationException: temperature is deprecated for this model` when an
   * older default leaks through. Empty set = no sampling knobs supported.
   */
  samplingParams: ReadonlySet<SamplingParam>;
}

const ALL_SAMPLING: ReadonlySet<SamplingParam> = new Set(['temperature', 'top_p', 'top_k']);
const NO_SAMPLING: ReadonlySet<SamplingParam> = new Set();

// Per-provider model-name predicates for thinking support. Kept narrow on
// purpose — when a new model family lands, add the regex here rather than
// guessing from prefix patterns elsewhere in the code.

/**
 * Strip Bedrock / Vertex / ARN wrappers off an Anthropic model id and return
 * a lowercased canonical short name suitable for substring matching.
 *
 * Inputs we have to handle in the wild:
 *   - first-party:        `claude-opus-4-7`, `claude-opus-4-7-20250101`
 *   - Vertex AI:          `claude-opus-4-7@20250101`
 *   - Bedrock foundation: `anthropic.claude-opus-4-7-v1:0`
 *   - Bedrock cross-region: `us.anthropic.claude-opus-4-7-20250101-v1:0`
 *                           (also `eu.`, `apac.`, `global.` prefixes)
 *   - Bedrock ARN:        `arn:aws:bedrock:us-east-1:123:inference-profile/us.anthropic.claude-opus-4-7-v1:0`
 *
 * We don't try to extract the exact short name — we just normalize to a form
 * where `name.includes('claude-opus-4-7')` is a reliable test. Mirrors
 * `firstPartyNameToCanonical()` in claude-code (utils/model/model.ts).
 */
export function canonicalizeAnthropicModel(model: string): string {
  let name = model.toLowerCase();
  // Strip ARN wrapper: `arn:…/<profile-id>` → `<profile-id>`
  if (name.startsWith('arn:')) {
    const slash = name.lastIndexOf('/');
    if (slash >= 0) name = name.slice(slash + 1);
  }
  return name;
}

function anthropicSupportsThinking(model: string): boolean {
  const name = canonicalizeAnthropicModel(model);
  // Claude 3.7 Sonnet and the entire 4.x line (opus/sonnet/haiku 4, 4.5, 4.6, 4.7…)
  if (name.includes('claude-3-7-')) return true;
  if (/claude-(opus|sonnet|haiku)-([4-9]|\d{2,})/.test(name)) return true;
  return false;
}

/**
 * Anthropic deprecated sampling knobs (temperature/top_p/top_k) starting with
 * the Opus 4.7 line. Older models (3.x, 4.x through 4.6) still accept them.
 * Bedrock enforces this strictly; api.anthropic.com is currently lenient but
 * will follow.
 *
 * Substring-matched on the canonicalized id so Bedrock cross-region inference
 * profiles (`us.anthropic.claude-opus-4-7-v1:0`), Vertex versions
 * (`claude-opus-4-7@20250101`), and ARNs all collapse to the same answer as
 * the bare first-party id.
 */
function anthropicSamplingParams(model: string): ReadonlySet<SamplingParam> {
  const name = canonicalizeAnthropicModel(model);
  // 4.7+ deprecated all sampling controls. Match `claude-(opus|sonnet|haiku)-4-7`
  // and any future minor (4-8, 4-9, 4-10…) plus the entire 5.x+ line.
  if (/claude-(opus|sonnet|haiku)-4-([7-9]|\d{2,})/.test(name)) return NO_SAMPLING;
  if (/claude-(opus|sonnet|haiku)-([5-9]|\d{2,})/.test(name)) return NO_SAMPLING;
  return ALL_SAMPLING;
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
        samplingParams: anthropicSamplingParams(model),
      };
    case 'openai':
      return {
        supportsNativeTools: true,
        supportsThinking: openaiSupportsReasoning(model),
        supportsParallelTools: true,
        // OpenAI reasoning models (o-series, gpt-5) reject temperature/top_p.
        samplingParams: openaiSupportsReasoning(model) ? NO_SAMPLING : ALL_SAMPLING,
      };
    case 'gemini':
      return {
        supportsNativeTools: true,
        supportsThinking: geminiSupportsThinking(model),
        supportsParallelTools: false,
        samplingParams: ALL_SAMPLING,
      };
    case 'ollama':
      // Per-model — runtime probe handles tool capability. Thinking is model
      // dependent (Qwen3-Thinking, QwQ have it) and we can't tell without a
      // probe; keep false so we don't send an unsupported flag.
      return {
        supportsNativeTools: true,
        supportsThinking: false,
        supportsParallelTools: false,
        samplingParams: ALL_SAMPLING,
      };
    case 'mock':
      return {
        supportsNativeTools: true,
        supportsThinking: false,
        supportsParallelTools: true,
        samplingParams: ALL_SAMPLING,
      };
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
