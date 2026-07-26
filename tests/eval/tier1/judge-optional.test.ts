/**
 * A run without a mechanism judge must still measure the things that never
 * needed one.
 *
 * The judge is consulted only on a run that already named the right object,
 * and it only moves PARTIAL to CORRECT or to WRONG. Everything decided before
 * it is deterministic — did the product commit to a cause at all, did it take
 * the trap, did it invent a cause on a healthy cluster — and those are the
 * numbers a reader most needs.
 *
 * The runner originally refused to start without a second vendor's key, which
 * meant nobody could learn the answer rate without two accounts. These pin the
 * split so that stays true: judge-free measures less, not worse, and the
 * unmeasurable part is withheld rather than guessed.
 */

import { describe, it, expect } from 'vitest';
import { score, summarize, type GroundTruth, type RunOutcome } from '../scoring/score.js';
import { HEALTHY_CONTROL_TRUTH } from './scenario.js';

const TRUTH: GroundTruth = {
  id: 'reviews-v2-latency',
  objectMustMatch: ['reviews-v2'],
  trapTokens: ['ratings-v1'],
  mechanism: 'a mesh rule delays reviews-v2',
};

const verified = (object: string) => ({
  gateStatus: 'passed' as const,
  rootCause: { status: 'confirmed', object, cause: 'because reasons' },
  confidence: 0.9,
});

describe('outcomes that never consult the judge', () => {
  it('declining to conclude is settled without one', () => {
    expect(score({ gateStatus: 'unresolved' }, TRUTH).outcome).toBe('UNRESOLVED');
  });

  it('taking the trap is settled without one', () => {
    const s = score(verified('ratings-v1'), TRUTH);
    expect(s.outcome).toBe('TRAPPED');
    expect(s.needsJudge).toBeUndefined();
  });

  it('naming a cause on a healthy cluster is settled without one', () => {
    const s = score(verified('deployment/reviews-v2'), HEALTHY_CONTROL_TRUTH);
    expect(s.outcome).toBe('WRONG');
    expect(s.confidentlyWrong).toBe(true);
    expect(s.needsJudge).toBeUndefined();
  });

  it('naming the wrong object is settled without one', () => {
    expect(score(verified('productpage'), TRUTH).needsJudge).toBeUndefined();
  });
});

describe('what a judge-free run can and cannot report', () => {
  const runs = (outcome: string, n: number, over: Partial<RunOutcome> = {}): RunOutcome[] =>
    Array.from({ length: n }, (_, i) => ({
      scenarioId: `f${i % 8}`,
      kind: 'injected' as const,
      rootCauseIsNotK8sObject: false,
      outcome,
      confidentlyWrong: false,
      ...over,
    }) as RunOutcome);

  it('reports the answer rate, which is what explains everything else', () => {
    // PARTIAL is where a judge-free run leaves a correct-object answer.
    const out = summarize([...runs('PARTIAL', 24), ...runs('UNRESOLVED', 8)]);
    expect(out.answerRate).toBeCloseTo(24 / 32);
  });

  it('reports false alarms, which the control cohort decides alone', () => {
    const out = summarize([
      ...runs('PARTIAL', 24),
      ...runs('WRONG', 2, { kind: 'control', confidentlyWrong: true, scenarioId: 'ctl' }),
      ...runs('UNRESOLVED', 2, { kind: 'control', scenarioId: 'ctl' }),
    ]);
    expect(out.falseAlarmRate).toBe(0.5);
  });

  it('withholds precision rather than reporting it as 0%', () => {
    // Without a judge no run can reach CORRECT, so precision computes to 0/24.
    // Printing "0% precision" would say the product is always wrong when it
    // means the mechanism was never graded — the exact class of misleading
    // number this harness exists to refuse.
    const out = summarize(runs('PARTIAL', 24), undefined, false);
    expect(out.precision).toBeNull();
    expect(out.withheld.join(' ')).toMatch(/mechanisms were not graded/);
    // The number that is real, and that explains the gap, still prints.
    expect(out.answerRate).toBe(1);
  });

  it('still reports precision normally when a judge did run', () => {
    const out = summarize([...runs('CORRECT', 18), ...runs('PARTIAL', 6)], undefined, true);
    expect(out.precision).not.toBeNull();
  });
});
