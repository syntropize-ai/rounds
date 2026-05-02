/**
 * When the LLM call fails (eg. invalid API key), the investigation must
 * transition to `failed` rather than hang or silently complete.
 *
 * Skipped because we don't have a runtime-mutate endpoint for the live
 * LLM config; rotating to a bad key requires a redeploy. See
 * helpers/llm.ts:forceLLMError for the recipe.
 */
import { describe, it } from 'vitest';

describe.skip('investigations/investigation-failed-on-error (Ref PR #128)', () => {
  it('rotates to a bad LLM key and observes investigation -> failed', () => {
    // Recipe (manual):
    //   1. helm upgrade ... --set llm.apiKey=invalid
    //   2. wait for the gateway pod to restart
    //   3. trigger an alert that auto-dispatches an investigation
    //   4. poll /api/investigations/:id until status === 'failed'
  });
});
