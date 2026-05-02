/**
 * LLM availability helpers.
 *
 * Anything that requires real model tool-calling (plans, investigation
 * summaries, agent reasoning) should opt in with `skipWithoutLLM`. Pure
 * backend behavior tests run unconditionally.
 */
import type { it as VitestIt } from 'vitest';

export const HAS_LLM = !!process.env['OPENOBS_TEST_LLM_API_KEY'];

/**
 * Stronger gate: only run when the operator opts into the LLM-quality
 * tier by setting OPENOBS_TEST_LLM_QUALITY=1. Use this for scenarios
 * whose assertion path depends on the agent's tool-calling fidelity
 * (e.g. `investigation_create` being emitted), which free-tier models
 * routinely skip. Run with `claude-haiku-4-5` / `gpt-4o-mini` or better.
 */
export const HAS_LLM_QUALITY = !!process.env['OPENOBS_TEST_LLM_QUALITY'];

export function skipWithoutLLM(it: typeof VitestIt): typeof VitestIt {
  return (HAS_LLM ? it : it.skip) as typeof VitestIt;
}

export function skipWithoutLLMQuality(it: typeof VitestIt): typeof VitestIt {
  return (HAS_LLM_QUALITY ? it : it.skip) as typeof VitestIt;
}

/**
 * Marker for tests that intentionally swap an invalid LLM key into the
 * runtime to exercise the failure path. Without a server-side admin
 * endpoint to mutate the live LLM config, scenarios that need this must
 * fall back to `it.skip` with a documented reason.
 */
export function forceLLMError(): { ok: false; reason: string } {
  return {
    ok: false,
    reason:
      'No HTTP path to swap an invalid LLM key at runtime; rotate via env + redeploy or skip',
  };
}
