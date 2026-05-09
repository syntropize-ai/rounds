// Per-model pricing for cost estimation in audit records.
//
// Prices are USD per 1,000,000 tokens (input/output) for the public list price
// of each model as of 2026-01. Sources:
//   - Anthropic:  https://www.anthropic.com/pricing#api
//   - OpenAI:     https://openai.com/api/pricing
//   - Google:     https://ai.google.dev/pricing  (Gemini API)
//   - DeepSeek:   https://api-docs.deepseek.com/quick_start/pricing
//
// When a model isn't in this table, `computeCostUsd()` returns `null` and the
// gateway logs a one-time warning instead of fabricating a $0 cost. Adding a
// new family is a matter of dropping its key + (input,output) prices below.
//
// Matching is substring-based on a lowercased model name so wrappers like
//   - `anthropic.claude-opus-4-7-v1:0`
//   - `claude-opus-4-7@20250101`
//   - `us.anthropic.claude-opus-4-7-20250101-v1:0`
// all collapse to the same `claude-opus-4-7` row.

import { createLogger } from '@agentic-obs/common/logging';

const log = createLogger('llm-gateway:pricing');

interface ModelPricing {
  /** USD per 1M input tokens. */
  inputPerMillion: number;
  /** USD per 1M output tokens. */
  outputPerMillion: number;
}

/**
 * Lookup table keyed by a substring of the (canonicalized, lowercased) model
 * name. Order matters — longer / more-specific keys come first so
 * `gpt-4o-mini` wins over `gpt-4o`.
 */
const PRICING_TABLE: ReadonlyArray<readonly [string, ModelPricing]> = [
  // Anthropic — Claude 4.x family
  ['claude-opus-4-7', { inputPerMillion: 15, outputPerMillion: 75 }],
  ['claude-opus-4-6', { inputPerMillion: 15, outputPerMillion: 75 }],
  ['claude-opus-4', { inputPerMillion: 15, outputPerMillion: 75 }],
  ['claude-sonnet-4-6', { inputPerMillion: 3, outputPerMillion: 15 }],
  ['claude-sonnet-4-5', { inputPerMillion: 3, outputPerMillion: 15 }],
  ['claude-sonnet-4', { inputPerMillion: 3, outputPerMillion: 15 }],
  ['claude-haiku-4-5', { inputPerMillion: 1, outputPerMillion: 5 }],
  ['claude-haiku-4', { inputPerMillion: 1, outputPerMillion: 5 }],
  // Anthropic — Claude 3.x family
  ['claude-3-7-sonnet', { inputPerMillion: 3, outputPerMillion: 15 }],
  ['claude-3-5-sonnet', { inputPerMillion: 3, outputPerMillion: 15 }],
  ['claude-3-5-haiku', { inputPerMillion: 0.8, outputPerMillion: 4 }],
  ['claude-3-opus', { inputPerMillion: 15, outputPerMillion: 75 }],
  ['claude-3-sonnet', { inputPerMillion: 3, outputPerMillion: 15 }],
  ['claude-3-haiku', { inputPerMillion: 0.25, outputPerMillion: 1.25 }],
  // OpenAI — GPT-5 / o-series reasoning
  ['gpt-5-mini', { inputPerMillion: 0.25, outputPerMillion: 2 }],
  ['gpt-5', { inputPerMillion: 1.25, outputPerMillion: 10 }],
  ['o3-mini', { inputPerMillion: 1.1, outputPerMillion: 4.4 }],
  ['o3', { inputPerMillion: 2, outputPerMillion: 8 }],
  ['o1-mini', { inputPerMillion: 1.1, outputPerMillion: 4.4 }],
  ['o1', { inputPerMillion: 15, outputPerMillion: 60 }],
  // OpenAI — GPT-4o family
  ['gpt-4o-mini', { inputPerMillion: 0.15, outputPerMillion: 0.6 }],
  ['gpt-4o', { inputPerMillion: 2.5, outputPerMillion: 10 }],
  ['gpt-4-turbo', { inputPerMillion: 10, outputPerMillion: 30 }],
  ['gpt-4', { inputPerMillion: 30, outputPerMillion: 60 }],
  ['gpt-3.5-turbo', { inputPerMillion: 0.5, outputPerMillion: 1.5 }],
  // Google Gemini
  ['gemini-2.5-pro', { inputPerMillion: 1.25, outputPerMillion: 10 }],
  ['gemini-2.5-flash', { inputPerMillion: 0.3, outputPerMillion: 2.5 }],
  ['gemini-2.0-flash', { inputPerMillion: 0.1, outputPerMillion: 0.4 }],
  ['gemini-1.5-pro', { inputPerMillion: 1.25, outputPerMillion: 5 }],
  ['gemini-1.5-flash', { inputPerMillion: 0.075, outputPerMillion: 0.3 }],
  // DeepSeek
  ['deepseek-chat', { inputPerMillion: 0.27, outputPerMillion: 1.1 }],
  ['deepseek-reasoner', { inputPerMillion: 0.55, outputPerMillion: 2.19 }],
];

/**
 * Track which unknown models we've already warned about so the log isn't
 * flooded by a single misconfigured model name. Keyed by raw model id —
 * memory is bounded by the number of distinct models the deployment uses.
 */
const warnedUnknown = new Set<string>();

export function lookupPricing(model: string): ModelPricing | null {
  const name = model.toLowerCase();
  for (const [key, price] of PRICING_TABLE) {
    if (name.includes(key)) return price;
  }
  return null;
}

/**
 * Compute USD cost for a call. Returns `null` when the model isn't in the
 * pricing table — the audit row stores `null` rather than a fabricated $0 so
 * downstream cost dashboards can distinguish "free" from "unknown".
 */
export function computeCostUsd(
  model: string,
  inputTokens: number,
  outputTokens: number,
): number | null {
  const price = lookupPricing(model);
  if (!price) {
    if (!warnedUnknown.has(model)) {
      warnedUnknown.add(model);
      log.warn({ model }, 'pricing: unknown model — cost_usd will be null');
    }
    return null;
  }
  return (
    (inputTokens * price.inputPerMillion) / 1_000_000 +
    (outputTokens * price.outputPerMillion) / 1_000_000
  );
}

/** @internal — for tests only. */
export function _resetPricingWarnCacheForTests(): void {
  warnedUnknown.clear();
}
