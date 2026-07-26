/**
 * The scorer decides what every accuracy number we ever publish means, so it
 * gets tested harder than the thing it grades.
 *
 * These run on every PR — the scorer is pure, so there is no reason not to.
 * The cases below are mostly ways a scorer can flatter the product: crediting
 * a near-miss, letting a judge rescue a wrong object, counting a run that
 * never happened. Each one, if it regressed, would move the published number
 * up rather than down, which is why they are worth pinning.
 */

import { describe, it, expect } from 'vitest';
import {
  score, applyJudge, summarize, names,
  type GroundTruth, type ScoredReport, type Outcome, type RunOutcome,
} from './score.js';
import { HEALTHY_CONTROL_TRUTH } from '../tier1/scenario.js';

const REVIEWS: GroundTruth = {
  id: 'reviews-v2-latency',
  objectMustMatch: ['reviews-v2'],
  trapTokens: ['ratings-v1'],
  mechanism: 'A VirtualService fixed delay was added to reviews-v2, so its own responses are slow.',
  shouldRuleOut: ['ratings latency'],
};

/** A report that passes the gate and names an object. Override per test. */
function verified(object: string, over: Partial<ScoredReport> = {}): ScoredReport {
  return {
    gateStatus: 'passed',
    rootCause: { status: 'confirmed', object, cause: 'because reasons' },
    confidence: 0.9,
    ...over,
  };
}

describe('names', () => {
  it('drops the words that every cluster object shares', () => {
    expect(names('the reviews service')).toEqual(['reviews']);
  });

  it('keeps a resource name whole', () => {
    // Splitting `reviews-v2` into `reviews` + `v2` is what let `checkout-canary`
    // match `checkout` — a different object, a different repair.
    expect(names('deployment/reviews-v2')).toEqual(['reviews-v2']);
    expect(names('checkout-canary')).toEqual(['checkout-canary']);
  });
});

describe('score — the object decision', () => {
  it('accepts the right object named any of the ways an operator would write it', () => {
    for (const phrasing of [
      'reviews-v2',
      'deployment/reviews-v2',
      'the reviews-v2 deployment in the default namespace',
      'Reviews-V2',
    ]) {
      expect(score(verified(phrasing), REVIEWS).outcome, phrasing).toBe('PARTIAL');
    }
  });

  it('refuses a version-less answer', () => {
    // "reviews" is not an actionable answer when v1 and v3 are healthy and v2
    // is not. Crediting it would let the eval report success for an answer an
    // operator cannot act on.
    const s = score(verified('the reviews service'), REVIEWS);
    expect(s.outcome).toBe('WRONG');
    expect(s.confidentlyWrong).toBe(true);
  });

  it('marks the plausible neighbour as TRAPPED, separately from any other wrong answer', () => {
    // reviews-v2 calls ratings-v1, so a slow reviews-v2 looks exactly like a
    // slow ratings-v1 from upstream. This is the answer the fault invites.
    const s = score(verified('ratings-v1'), REVIEWS);
    expect(s.outcome).toBe('TRAPPED');
    expect(s.confidentlyWrong).toBe(true);
  });

  it('prefers the correct answer when the trap is genuinely part of it', () => {
    const overlapping: GroundTruth = {
      ...REVIEWS,
      objectMustMatch: ['ratings-v1', 'reviews-v2'],
      trapTokens: ['ratings-v1'],
    };
    expect(score(verified('ratings-v1 called by reviews-v2'), overlapping).outcome).toBe('PARTIAL');
  });

  it('counts the trap as hit even when the right answer is named alongside it', () => {
    // Covering both bases must not beat committing to one. Under the earlier
    // rule this scored PARTIAL and could reach CORRECT via the judge, which
    // made hedging strictly dominant.
    expect(score(verified('ratings-v1 or reviews-v2'), REVIEWS).outcome).toBe('TRAPPED');
  });

  it('rejects a list of candidates as no answer at all', () => {
    // An operator handed three services has been told nothing.
    const s = score(verified('reviews-v1, reviews-v2, reviews-v3'), REVIEWS);
    expect(s.outcome).toBe('WRONG');
    expect(s.confidentlyWrong).toBe(true);
  });

  it('rejects a neighbouring name that merely shares a prefix', () => {
    const truth: GroundTruth = { id: 'c', objectMustMatch: ['deployment/checkout'], mechanism: 'm' };
    expect(score(verified('checkout-canary'), truth).outcome).toBe('WRONG');
    expect(score(verified('deployment/checkout'), truth).outcome).toBe('PARTIAL');
  });

  it('rejects the right name under the wrong resource kind', () => {
    // `service/checkout` and `deployment/checkout` are edited in different
    // places, so an answer naming the wrong one is not actionable.
    const truth: GroundTruth = { id: 'c', objectMustMatch: ['deployment/checkout'], mechanism: 'm' };
    expect(score(verified('service/checkout'), truth).outcome).toBe('WRONG');
    // No kind claimed on either side means no kind constraint to violate.
    expect(score(verified('the checkout deployment'), truth).outcome).toBe('PARTIAL');
  });

  it('reports whether it eliminated something that was actually in play', () => {
    // The gate is satisfied by ruling out anything at all — the moon phase
    // clears it. This is recorded so a correct answer that eliminated nothing
    // real is visible as such, not so it changes the outcome.
    const real = score(verified('reviews-v2', { ruledOut: ['ratings-v1 latency'] }), REVIEWS);
    expect(real.eliminatedSomethingReal).toBe(true);
    expect(real.outcome).toBe('PARTIAL');

    const strawMan = score(verified('reviews-v2', { ruledOut: ['the moon phase'] }), REVIEWS);
    expect(strawMan.eliminatedSomethingReal).toBe(false);
    // Still PARTIAL: it is reported, not penalised.
    expect(strawMan.outcome).toBe('PARTIAL');

    const noExpectation = score(verified('checkout'), { id: 'x', objectMustMatch: ['checkout'], mechanism: 'm' });
    expect(noExpectation.eliminatedSomethingReal).toBeNull();
  });

  it('treats a verified verdict with no object as a wrong answer, not a shrug', () => {
    const s = score(verified('', { rootCause: { status: 'confirmed', object: '   ' } }), REVIEWS);
    expect(s.outcome).toBe('WRONG');
    expect(s.confidentlyWrong).toBe(true);
  });
});

describe('score — declining to conclude', () => {
  it('is UNRESOLVED, not WRONG, when the gate withheld the verdict', () => {
    // The product is built to do this when evidence is thin. Scoring it as a
    // wrong answer would make the eval reward exactly the overconfidence the
    // gate exists to prevent.
    const s = score({ gateStatus: 'unresolved', rootCause: { object: 'reviews-v2' } }, REVIEWS);
    expect(s.outcome).toBe('UNRESOLVED');
    expect(s.confidentlyWrong).toBe(false);
  });

  it('is UNRESOLVED when the report says so even if the gate passed', () => {
    const s = score(verified('reviews-v2', { rootCause: { status: 'unresolved', object: 'reviews-v2' } }), REVIEWS);
    expect(s.outcome).toBe('UNRESOLVED');
  });

  it('never credits an unresolved run for guessing right', () => {
    // An unresolved report naming the correct object is still unresolved. If
    // this credited, rcaAt1 would count answers the product refused to stand
    // behind and never showed an operator as a conclusion.
    const s = score({ gateStatus: 'unresolved', rootCause: { object: 'reviews-v2', cause: 'slow' } }, REVIEWS);
    expect(s.outcome).not.toBe('CORRECT');
    expect(s.needsJudge).toBeUndefined();
  });
});

describe('score — the healthy control', () => {
  it('accepts a shrug', () => {
    expect(score({ gateStatus: 'unresolved' }, HEALTHY_CONTROL_TRUTH).outcome).toBe('UNRESOLVED');
  });

  it('fails any confident root cause on a cluster where nothing was broken', () => {
    // The catastrophic outcome. A product that invents a cause when asked
    // about a healthy system will do it during a real incident too.
    const s = score(verified('deployment/reviews-v2'), HEALTHY_CONTROL_TRUTH);
    expect(s.outcome).toBe('WRONG');
    expect(s.confidentlyWrong).toBe(true);
  });
});

describe('score — invalid runs', () => {
  it('is INVALID when no report exists, and not counted as either kind of answer', () => {
    const s = score(null, REVIEWS);
    expect(s.outcome).toBe('INVALID');
    expect(s.confidentlyWrong).toBe(false);
  });
});

describe('applyJudge', () => {
  const base = score(verified('reviews-v2'), REVIEWS);

  it('promotes to CORRECT only once the mechanism is confirmed', () => {
    expect(base.outcome).toBe('PARTIAL');
    expect(applyJudge(base, 'matches').outcome).toBe('CORRECT');
  });

  it('downgrades a contradicted mechanism to a confidently wrong answer', () => {
    // Right service, wrong story. Still a bad answer to act on: the remediation
    // follows from the mechanism, not the name.
    const s = applyJudge(base, 'contradicts');
    expect(s.outcome).toBe('WRONG');
    expect(s.confidentlyWrong).toBe(true);
  });

  it('cannot rescue a wrong object', () => {
    // The whole point of deciding the object before consulting a judge. A
    // model that argues well for the wrong service must not be able to talk
    // its way to CORRECT.
    for (const wrong of [score(verified('ratings-v1'), REVIEWS), score(verified('productpage'), REVIEWS)]) {
      expect(applyJudge(wrong, 'matches').outcome).toBe(wrong.outcome);
      expect(applyJudge(wrong, 'matches').confidentlyWrong).toBe(true);
    }
  });

  it('carries forward what the object pass observed', () => {
    const withElimination = score(verified('reviews-v2', { ruledOut: ['ratings-v1 latency'] }), REVIEWS);
    expect(applyJudge(withElimination, 'matches').eliminatedSomethingReal).toBe(true);
    expect(applyJudge(withElimination, 'contradicts').eliminatedSomethingReal).toBe(true);
  });

  it('cannot rescue an unresolved run', () => {
    const unresolved = score({ gateStatus: 'unresolved' }, REVIEWS);
    expect(applyJudge(unresolved, 'matches').outcome).toBe('UNRESOLVED');
  });
});

describe('summarize', () => {
  /** n runs of one outcome, spread over `scenarios` distinct scenarios. */
  const runs = (
    outcome: Outcome,
    n: number,
    { kind = 'injected' as const, confidentlyWrong = false, scenarios = 8, tag = 'f', inProcess = false } = {},
  ): RunOutcome[] =>
    Array.from({ length: n }, (_, i) => ({
      scenarioId: `${tag}${i % scenarios}`,
      kind,
      rootCauseIsNotK8sObject: inProcess,
      outcome,
      confidentlyWrong,
    }));

  /** A run big enough to clear every publication threshold. */
  const healthy = () => [
    ...runs('CORRECT', 16),
    ...runs('WRONG', 8, { confidentlyWrong: true }),
    ...runs('UNRESOLVED', 8),
  ];

  it('publishes answerRate and precision that multiply back to plain accuracy', () => {
    const out = summarize(healthy());
    expect(out.withheld).toEqual([]);
    expect(out.answerRate).toBeCloseTo(24 / 32);
    expect(out.precision).toBeCloseTo(16 / 24);
  });

  it('does not let control runs move the numbers for real faults', () => {
    // The cheapest way to improve a safety score is to add runs where nothing
    // is broken. Controls have nothing to inject and nothing to revert, so if
    // they shared a denominator this would be the first thing anyone reached
    // for. Adding sixteen must change the injected-fault numbers by nothing.
    const base = summarize(healthy());
    const padded = summarize([
      ...healthy(),
      ...runs('UNRESOLVED', 16, { kind: 'control', scenarios: 1, tag: 'ctl' }),
    ]);
    expect(padded.answerRate).toBeCloseTo(base.answerRate!);
    expect(padded.precision).toBeCloseTo(base.precision!);
    expect(padded.falseAlarmRate).toBe(0);
    expect(padded.injected.graded).toBe(base.injected.graded);
  });

  it('reports a control that invented a cause as a false alarm', () => {
    const out = summarize([
      ...healthy(),
      ...runs('WRONG', 2, { kind: 'control', confidentlyWrong: true, scenarios: 1, tag: 'ctl' }),
      ...runs('UNRESOLVED', 2, { kind: 'control', scenarios: 1, tag: 'ctl' }),
    ]);
    expect(out.falseAlarmRate).toBe(0.5);
  });

  it('withholds the rates when the harness lost too many runs', () => {
    const out = summarize([...healthy(), ...runs('INVALID', 12)]);
    expect(out.precision).toBeNull();
    expect(out.withheld.join(' ')).toMatch(/could not be graded/);
  });

  it('withholds the rates when there were too few runs to mean anything', () => {
    const out = summarize(runs('CORRECT', 6));
    expect(out.precision).toBeNull();
    expect(out.withheld.join(' ')).toMatch(/below the floor/);
  });

  it('withholds the rates when one scenario dominates the sample', () => {
    // Twenty runs of one fault is that fault's pass rate, not the product's.
    const out = summarize(runs('CORRECT', 24, { scenarios: 2 }));
    expect(out.precision).toBeNull();
    expect(out.withheld.join(' ')).toMatch(/of the graded runs/);
  });

  it('withholds precision when the product mostly refuses to answer', () => {
    // The loophole a single accuracy number cannot catch: a gate tightened
    // until it never commits scores zero confidently-wrong and reads as safe.
    // Precision over the few runs it did answer would flatter it further.
    const out = summarize([...runs('UNRESOLVED', 28), ...runs('CORRECT', 4)]);
    expect(out.precision).toBeNull();
    expect(out.answerRate).toBeLessThan(0.3);
    expect(out.withheld.join(' ')).toMatch(/mostly does not answer/);
  });

  it('still reports answerRate when precision is withheld', () => {
    // It is the number that explains why the others are missing.
    expect(summarize([...runs('UNRESOLVED', 28), ...runs('CORRECT', 4)]).answerRate).not.toBeNull();
  });

  it('separates the two fault classes, because they are not one measurement', () => {
    // The failure worth catching: it answers resource faults readily and
    // almost never commits on a value inside a process. A blended answer rate
    // of 55% reports that as mild; 90% versus 20% reports it as the finding.
    const out = summarize([
      ...runs('CORRECT', 18, { scenarios: 3, tag: 'k8s' }),
      ...runs('UNRESOLVED', 2, { scenarios: 3, tag: 'k8s' }),
      ...runs('UNRESOLVED', 16, { scenarios: 2, tag: 'proc', inProcess: true }),
      ...runs('CORRECT', 4, { scenarios: 2, tag: 'proc', inProcess: true }),
    ]);
    expect(out.answerRateByClass.k8sObject!).toBeGreaterThan(0.8);
    expect(out.answerRateByClass.inProcess!).toBeLessThan(0.3);
  });

  it('reports no in-process rate when the library has none, rather than zero', () => {
    // Zero would read as "it never answers those", when the truth is that none
    // were run — a library that has drifted, which is a different problem.
    expect(summarize(runs('CORRECT', 24)).answerRateByClass.inProcess).toBeNull();
  });

  it('returns nulls rather than dividing by zero on an empty run', () => {
    const out = summarize([]);
    expect(out.answerRate).toBeNull();
    expect(out.precision).toBeNull();
    expect(out.falseAlarmRate).toBeNull();
  });

  it('weights scenarios equally rather than by how often they were run', () => {
    // Cheap scenarios get run more, so micro-averaging would let the fastest
    // fault set the headline number. Here the one scenario run most often is
    // also the one the product fails: 10 wrong of 40 runs, but 1 failing
    // scenario of 6. Macro says 83%, micro would say 75%.
    const out = summarize([
      ...runs('WRONG', 10, { scenarios: 1, tag: 'cheap', confidentlyWrong: true }),
      ...runs('CORRECT', 30, { scenarios: 5, tag: 'x' }),
    ]);
    expect(out.withheld).toEqual([]);
    expect(out.precision).toBeCloseTo(5 / 6);
    expect(out.precision).not.toBeCloseTo(30 / 40);
  });
});
