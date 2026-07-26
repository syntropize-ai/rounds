/**
 * Properties the scenario library has to hold, checked on every PR.
 *
 * None of these need a cluster — they are about how the scenarios are written,
 * and every one of them is a way a live run could report a number that is
 * higher than the truth without anybody noticing. A leaked answer, a question
 * that names its own fault, or a library that has quietly drifted to only the
 * faults a token scorer can grade all look fine in a nightly report.
 */

import { describe, it, expect } from 'vitest';
import { SCENARIOS, INJECTED_RESOURCE_NAMES } from './scenarios/index.js';
import { names, score } from '../scoring/score.js';

describe('scenario library', () => {
  it('has scenarios', () => {
    expect(SCENARIOS.length).toBeGreaterThan(0);
  });

  it('gives every scenario a distinct id', () => {
    expect(new Set(SCENARIOS.map((s) => s.id)).size).toBe(SCENARIOS.length);
  });

  it('never writes the answer into a resource name the injection creates', () => {
    // A fault called `eval-reviews-v2-latency` is solved by `kubectl get
    // virtualservice`. The eval would then be measuring whether the agent
    // lists resources, and would score well for exactly the wrong reason.
    const answers = SCENARIOS.flatMap((s) => [
      ...s.truth.objectMustMatch,
      ...(s.truth.alsoAccept ?? []).flat(),
    ]).flatMap(names);
    for (const resource of INJECTED_RESOURCE_NAMES) {
      const leaked = answers.filter((a) => resource.includes(a) && !INJECTED_RESOURCE_NAMES.includes(a));
      expect(leaked, `"${resource}" contains the answer ${leaked.join(', ')}`).toEqual([]);
    }
  });

  it('never names the fault in the question', () => {
    // The question is what an operator would say. An operator who already
    // knows which service is broken does not need an investigation, and a
    // question that gives it away turns the eval into a formatting test.
    for (const s of SCENARIOS) {
      const asked = new Set(names(s.question));
      const given = s.truth.objectMustMatch.flatMap(names).filter((n) => asked.has(n));
      expect(given, `${s.id} asks about ${given.join(', ')} by name`).toEqual([]);
    }
  });

  it('keeps at least one fault whose root cause is not a Kubernetes object', () => {
    // The library drifts toward faults a token match can grade, because those
    // are the ones that are easy to score. That drift quietly excludes the
    // class where the evidence gate actually struggles — a value inside a
    // process, with no resource to name — and the numbers never show it.
    const faults = SCENARIOS.filter((s) => s.kind === 'injected');
    const notK8s = faults.filter((s) => s.rootCauseIsNotK8sObject);
    expect(
      notK8s.length,
      `all ${faults.length} faults have a Kubernetes object as their root cause`,
    ).toBeGreaterThan(0);
  });

  it('gives every fault a trap, and a trap that is not the answer', () => {
    for (const s of SCENARIOS.filter((x) => x.kind === 'injected')) {
      expect(s.truth.trapTokens?.length, `${s.id} has no trap`).toBeGreaterThan(0);
      // A trap that the correct answer also satisfies can never be scored.
      const answer = { gateStatus: 'passed' as const, rootCause: { status: 'confirmed', object: s.truth.objectMustMatch.join(' ') } };
      expect(score(answer, s.truth).outcome, `${s.id}'s own answer scores as trapped`).not.toBe('TRAPPED');
    }
  });

  it('grades its own ground truth as a correct object', () => {
    // Catches an `objectMustMatch` that tokenizes to nothing, which makes
    // every answer WRONG and confidently-wrong — including a perfect one.
    for (const s of SCENARIOS.filter((x) => x.kind === 'injected')) {
      const answer = { gateStatus: 'passed' as const, rootCause: { status: 'confirmed', object: s.truth.objectMustMatch.join(' '), cause: s.truth.mechanism } };
      expect(score(answer, s.truth).outcome, `${s.id} cannot score its own answer`).toBe('PARTIAL');
    }
  });

  it('explains what each scenario is for', () => {
    // A scenario without a stated reason to exist is padding the denominator.
    for (const s of SCENARIOS) {
      expect(s.rationale.length, `${s.id} needs a rationale`).toBeGreaterThan(80);
      expect(s.truth.mechanism.length, `${s.id} needs a mechanism`).toBeGreaterThan(30);
    }
  });
});
