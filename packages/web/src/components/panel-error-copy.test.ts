import { describe, it, expect } from 'vitest';
import { explainPanelError } from './panel-error-copy.js';

/** The exact string the API emits — see routes/dashboard/query.ts. */
const NO_DATASOURCE =
  'Datasource ds-3f8a1c7e-9b21-4d0e-8f5a-1c2d3e4f5a6b not found, not Prometheus, or not in your org';

describe('explainPanelError', () => {
  it('leads with the cause and the fix, not the uuid', () => {
    // The most common panel failure on a self-hosted install: a dashboard
    // pointing at a connector that has since been renamed or deleted.
    const { summary, detail } = explainPanelError(NO_DATASOURCE);
    expect(summary).not.toContain('ds-3f8a1c7e');
    expect(summary).toContain('no longer exists');
    expect(summary).toContain('Settings');
    // Still available to whoever is debugging.
    expect(detail).toBe(NO_DATASOURCE);
  });

  it('does not present three different problems as one sentence', () => {
    // "not found, not Prometheus, or not in your org" is addressed to whoever
    // wrote the backend. A reader cannot act on a disjunction.
    expect(explainPanelError(NO_DATASOURCE).summary).not.toContain('or not in your org');
  });

  it('explains a schema mismatch as a version skew', () => {
    const { summary } = explainPanelError('API response shape mismatch for RangeResponse');
    expect(summary).toContain('out of step');
    expect(summary).not.toContain('RangeResponse');
  });

  it('distinguishes rate limiting from an unreachable source', () => {
    expect(explainPanelError('429 too many requests').summary).toContain('rate-limiting');
    expect(explainPanelError('fetch failed: network error').summary).toContain('Could not reach');
  });

  it('sends a bad query back to the panel editor', () => {
    expect(explainPanelError('parse error at char 14: unexpected ")"').summary)
      .toContain('Edit the panel');
  });

  it('passes an unrecognised error through rather than guessing', () => {
    // Inventing a friendly reading of an error we do not understand is worse
    // than showing it: it sends the reader somewhere that will not help.
    const odd = 'upstream returned 418';
    const out = explainPanelError(odd);
    expect(out.summary).toBe(odd);
    // and does not repeat itself in the disclosure
    expect(out.detail).toBeUndefined();
  });
});
