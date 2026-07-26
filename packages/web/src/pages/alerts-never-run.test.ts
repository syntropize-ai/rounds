/**
 * "Normal" on an alerting product is a claim: I evaluated this and nothing is
 * wrong. A rule that has never been evaluated must not make that claim.
 *
 * Enabling a rule sets `state: 'normal'` server-side, so a rule created while
 * the evaluator is down — or before any metrics connector exists — showed a
 * green NORMAL badge from the moment it was saved. The failure is silent and
 * self-reinforcing: the page most likely to be checked during an incident is
 * the one telling you it is fine.
 */

import { describe, it, expect } from 'vitest';
import { hasNeverRun, nextEval } from './Alerts.js';

const rule = (over: Record<string, unknown> = {}) =>
  ({
    id: 'r1',
    state: 'normal',
    evaluationIntervalSec: 60,
    ...over,
  }) as never;

describe('hasNeverRun', () => {
  it('is true for an enabled rule that has not been evaluated', () => {
    expect(hasNeverRun(rule())).toBe(true);
  });

  it('is false once the rule has actually run', () => {
    expect(hasNeverRun(rule({ lastEvaluatedAt: '2026-07-26T00:00:00.000Z' }))).toBe(false);
  });

  it('is false for a disabled rule, which already renders as disabled', () => {
    expect(hasNeverRun(rule({ state: 'disabled' }))).toBe(false);
  });

  it('is true for a firing rule with no evaluation timestamp', () => {
    // Should not happen, but if the state and the timestamp disagree, the
    // timestamp is the one grounded in something having occurred.
    expect(hasNeverRun(rule({ state: 'firing' }))).toBe(true);
  });
});

describe('nextEval', () => {
  it('does not reuse the word "pending", which is also an alert state', () => {
    // `pending` means "condition met, waiting out forDurationSec" three columns
    // to the left in the same row. The same word meaning two unrelated things
    // in one row is worse than either wording alone.
    expect(nextEval(rule())).not.toContain('pending');
    expect(nextEval(rule())).toBe('never run');
  });

  it('counts down from the last evaluation once there is one', () => {
    const justRan = rule({ lastEvaluatedAt: new Date().toISOString(), evaluationIntervalSec: 60 });
    expect(nextEval(justRan)).toMatch(/^in \d+[sm]$/);
  });
});
