/**
 * LLM availability helpers.
 *
 * Anything that requires real model tool-calling (plans, investigation
 * summaries, agent reasoning) should opt in with `skipWithoutLLM`. Pure
 * backend behavior tests run unconditionally.
 */
import type { it as VitestIt } from 'vitest';

export const HAS_LLM = !!process.env['OPENOBS_TEST_LLM_API_KEY'];

export function skipWithoutLLM(it: typeof VitestIt): typeof VitestIt {
  return (HAS_LLM ? it : it.skip) as typeof VitestIt;
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
