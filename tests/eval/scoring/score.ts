/**
 * Scoring a real investigation against a known fault.
 *
 * Tier-0 replays recordings; this grades live runs. The hard part is that a
 * root cause is prose, so "did it get it right" cannot be a string comparison.
 *
 * The split that makes it tractable: `rootCause.object` is not really free
 * text. It is a reference to a thing in the cluster — `deployment/checkout`,
 * `configmap/api-config` — drawn from a closed vocabulary we control when we
 * inject the fault. That part is decided here, deterministically, and never
 * handed to a model. Only the causal mechanism, one sentence of genuine prose,
 * needs a judge.
 *
 * Keeping the object decision out of the judge's hands matters: it means a
 * judge cannot launder a confident answer about the wrong service into a pass,
 * which is the failure mode that would quietly make the whole eval worthless.
 *
 * This module is pure. It takes a report and a ground truth and returns an
 * outcome — no network, no model, no cluster — so it can be tested directly
 * and so the live runner has nothing interesting left to get wrong.
 */

/** What actually happened, written when the fault is designed. */
export interface GroundTruth {
  id: string;
  /** Names that must all appear in the reported object for it to be the right thing. */
  objectMustMatch: string[];
  /**
   * Other complete answers that are equally actionable.
   *
   * Needed because a fault often has more than one honest repair target. A
   * mesh rule that delays one workload's calls can be named by the rule or by
   * the workload; both tell an operator where to go. The alternative is
   * marking a literally-correct answer wrong because it picked the other end
   * of the same fault, which measures phrasing rather than diagnosis.
   *
   * Each entry is a complete answer in its own right, joined by AND like
   * `objectMustMatch`. Keep the list short — every addition is a claim that
   * this too would be useful at 3am, and a long list is how an eval stops
   * discriminating.
   */
  alsoAccept?: string[][];
  /**
   * Tokens that mark a specific wrong answer this fault invites — the
   * plausible neighbour that a shallow investigation lands on. Reporting one
   * of these is worse than giving up, and is scored separately.
   */
  trapTokens?: string[];
  /** The field or property at fault, when the fault has one. */
  field?: string;
  /** A human-readable statement of the mechanism, for the judge's anchors. */
  mechanism: string;
  /** Hypotheses a competent investigation should have eliminated. */
  shouldRuleOut?: string[];
  /**
   * Worked examples the judge matches against, written by whoever designed the
   * fault. Without them the judge is asked whether it agrees with an
   * explanation, which it usually does.
   */
  judgeAnchors?: {
    matches: string[];
    contradicts: string[];
  };
}

/** A report as the API returns it, narrowed to what scoring reads. */
export interface ScoredReport {
  gateStatus?: 'passed' | 'unresolved';
  rootCause?: {
    status?: string;
    object?: string;
    field?: string;
    cause?: string;
  };
  confidence?: number;
  ruledOut?: string[];
}

export type Outcome =
  /** Right object, right mechanism. */
  | 'CORRECT'
  /** Right object, mechanism wrong or unconvincing. */
  | 'PARTIAL'
  /** Wrong object. */
  | 'WRONG'
  /** Landed on the specific wrong answer the fault invites. */
  | 'TRAPPED'
  /** Declined to conclude. Not a success, but honest. */
  | 'UNRESOLVED'
  /** The run did not produce a gradable result. Excluded from the denominator. */
  | 'INVALID';

export interface Score {
  outcome: Outcome;
  /** Why, in a sentence, for the run log. */
  reason: string;
  /**
   * True when the product presented this as a verified root cause and it was
   * wrong. The most expensive failure mode: a confident lie is worse than a
   * shrug, because a shrug does not authorise a change.
   */
  confidentlyWrong: boolean;
  /** Set when a judge is needed to settle the mechanism. */
  needsJudge?: { mechanism: string; reported: string };
  /**
   * Whether it eliminated a hypothesis that was genuinely in play, from the
   * list written when the fault was designed.
   *
   * Reported, never used to decide the outcome. The gate is satisfied by
   * ruling out anything at all — the moon phase clears it — so a run can be
   * correct while having eliminated nothing real. That is worth seeing rather
   * than punishing: it is a fact about how the answer was reached, and folding
   * it into accuracy would hide both numbers. Null when the scenario did not
   * say what should have been ruled out.
   */
  eliminatedSomethingReal?: boolean | null;
}

/** Resource kinds. Carried separately because they say what to edit, not which one. */
const KINDS = new Set([
  'deployment', 'deployments', 'statefulset', 'daemonset', 'replicaset', 'pod', 'pods',
  'service', 'services', 'svc', 'configmap', 'secret', 'namespace', 'ns', 'container',
  'node', 'job', 'cronjob', 'ingress', 'virtualservice', 'destinationrule', 'pvc',
  'persistentvolumeclaim', 'app', 'workload', 'endpoint',
]);

/** Prose that carries no identity. */
const NOISE = new Set([
  'the', 'a', 'an', 'in', 'on', 'of', 'and', 'is', 'to', 'for', 'its', 'it',
  'this', 'that', 'was', 'were', 'are', 'be', 'at', 'by', 'from', 'with',
  'under', 'within', 'running', 'called', 'named',
]);

/**
 * The names an answer contains, hyphens intact.
 *
 * Keeping `reviews-v2` whole rather than splitting it into `reviews` + `v2` is
 * what stops `checkout-canary` from matching `checkout`. Those are different
 * repair targets, and an eval that scores them the same is measuring whether
 * the model said a familiar word.
 */
export function names(value: string): string[] {
  return value
    .toLowerCase()
    .split(/[/\s,;|]+/)
    .map((t) => t.replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, ''))
    .filter((t) => t.length >= 2 && !KINDS.has(t) && !NOISE.has(t) && t !== 'or' && t !== 'either');
}

/** The resource kind an answer commits to, if it commits to one. */
function kindOf(value: string): string | null {
  const found = value.toLowerCase().split(/[/\s,;|]+/).find((t) => KINDS.has(t.replace(/[^a-z0-9]/g, '')));
  return found ? found.replace(/[^a-z0-9]/g, '') : null;
}

/**
 * Did the report name the right thing?
 *
 * Every required name must be present. A fault on `reviews-v2` is not found by
 * an answer that says `reviews`: naming the service without the version is the
 * difference between a change an operator can make and one they cannot. And
 * when both sides commit to a resource kind, the kinds must agree — `service/
 * checkout` and `deployment/checkout` are edited in different places.
 */
function namesObject(reported: string, must: string[]): boolean {
  if (must.length === 0) return false;
  const got = new Set(names(reported));
  const kindsAgree = must.every((m) => {
    const wanted = kindOf(m);
    const claimed = kindOf(reported);
    return !wanted || !claimed || wanted === claimed;
  });
  if (!kindsAgree) return false;
  return must.every((m) => {
    const wanted = names(m);
    return wanted.length > 0 && wanted.every((n) => got.has(n));
  });
}

function hitsTrap(reported: string, traps: string[] | undefined): boolean {
  if (!traps?.length) return false;
  const got = new Set(names(reported));
  return traps.some((trap) => {
    const t = names(trap);
    return t.length > 0 && t.every((n) => got.has(n));
  });
}

/**
 * Did the answer name more than one candidate?
 *
 * Hedging is otherwise strictly dominant: under a "are the required names
 * present" test, an answer that lists every service it considered can never be
 * wrong and can never be trapped. But a root cause is a repair target, and a
 * list is not one — an operator handed three services has been told nothing.
 *
 * Extra descriptive words are fine; extra *names* are not.
 */
function isHedged(reported: string, must: string[]): boolean {
  const required = new Set(must.flatMap(names));
  const extras = names(reported).filter((n) => !required.has(n));
  // A namespace or a qualifier is one extra name and reads as description.
  // Two or more, alongside the answer, is a list of candidates.
  return extras.length >= 2 && /[,;]|\bor\b|\beither\b/i.test(reported);
}

export function score(report: ScoredReport | null, truth: GroundTruth): Score {
  if (!report) {
    return {
      outcome: 'INVALID',
      reason: 'no report was produced',
      confidentlyWrong: false,
    };
  }

  const verified = report.gateStatus === 'passed';

  // Declining to conclude is a legitimate outcome and must not be graded as a
  // wrong answer — the product is designed to do this when evidence is thin,
  // and punishing it here would train exactly the overconfidence we are
  // trying to measure.
  if (!verified || report.rootCause?.status === 'unresolved') {
    return {
      outcome: 'UNRESOLVED',
      reason: 'the investigation did not claim a verified root cause',
      confidentlyWrong: false,
    };
  }

  const reportedObject = report.rootCause?.object ?? '';
  if (!reportedObject.trim()) {
    return {
      outcome: 'WRONG',
      reason: 'claimed a verified root cause without naming an object',
      confidentlyWrong: true,
    };
  }

  // Naming the trap counts as hitting it even when the right answer is named
  // too. The earlier rule — trap only if the correct object is absent — made
  // "ratings-v1 or reviews-v2" score as a correct answer, so covering both
  // bases beat committing to one.
  const trapIsPartOfTheAnswer = (truth.trapTokens ?? []).every((t) =>
    hitsTrap(truth.objectMustMatch.join(' '), [t]));
  if (hitsTrap(reportedObject, truth.trapTokens) && !trapIsPartOfTheAnswer) {
    return {
      outcome: 'TRAPPED',
      reason: `named "${reportedObject}", the plausible neighbour this fault invites, rather than ${truth.objectMustMatch.join(' + ')}`,
      confidentlyWrong: true,
    };
  }

  // Checked before the answer is looked for, like the trap: an answer that
  // contains the right name among four candidates has still not committed.
  if (isHedged(reportedObject, truth.objectMustMatch)) {
    return {
      outcome: 'WRONG',
      reason: `named several candidates ("${reportedObject}") rather than one repair target`,
      confidentlyWrong: true,
    };
  }

  const accepted = [truth.objectMustMatch, ...(truth.alsoAccept ?? [])];
  if (!accepted.some((form) => namesObject(reportedObject, form))) {
    return {
      outcome: 'WRONG',
      reason: `named "${reportedObject}" but the fault was in ${truth.objectMustMatch.join(' + ')}`,
      confidentlyWrong: true,
    };
  }

  // Right object. Whether the mechanism is right is a question about prose,
  // and is the only thing a judge is asked.
  return {
    outcome: 'PARTIAL',
    reason: 'named the right object; mechanism needs judging',
    confidentlyWrong: false,
    eliminatedSomethingReal: eliminatedSomethingReal(report.ruledOut, truth.shouldRuleOut),
    needsJudge: {
      mechanism: truth.mechanism,
      reported: report.rootCause?.cause ?? '',
    },
  };
}

/**
 * Did any of what it ruled out correspond to a hypothesis that was actually
 * in play? Matched on names, because the wording will differ — "ratings-v1
 * being slow" and "the ratings service is overloaded" are the same
 * elimination.
 */
function eliminatedSomethingReal(
  reported: string[] | undefined,
  expected: string[] | undefined,
): boolean | null {
  if (!expected?.length) return null;
  if (!reported?.length) return false;
  const said = new Set(reported.flatMap(names));
  return expected.some((e) => {
    const want = names(e);
    return want.length > 0 && want.some((n) => said.has(n));
  });
}

/**
 * Fold a judge's verdict into a score. The judge can only confirm or downgrade
 * — it is never allowed to promote a wrong object into a correct answer, which
 * is why the object decision happened before it was consulted.
 */
export function applyJudge(base: Score, verdict: 'matches' | 'partial' | 'contradicts'): Score {
  if (!base.needsJudge) return base;
  // `needsJudge` is dropped — it has been answered — but everything the object
  // pass observed is carried forward, or the report loses it silently.
  const kept = { eliminatedSomethingReal: base.eliminatedSomethingReal ?? null };
  if (verdict === 'matches') {
    return { ...kept, outcome: 'CORRECT', reason: 'object and mechanism both correct', confidentlyWrong: false };
  }
  if (verdict === 'partial') {
    return { ...kept, outcome: 'PARTIAL', reason: 'right object, mechanism only partly right', confidentlyWrong: false };
  }
  return {
    ...kept,
    outcome: 'WRONG',
    reason: 'right object, but the stated mechanism contradicts what actually happened',
    confidentlyWrong: true,
  };
}

/** One graded run, tagged with where it came from. */
export interface RunOutcome {
  scenarioId: string;
  /** Controls have no fault. They answer a different question and are counted apart. */
  kind: 'injected' | 'control';
  /** Carried so the two fault classes can be reported apart — see `answerRateByClass`. */
  rootCauseIsNotK8sObject: boolean;
  outcome: Outcome;
  confidentlyWrong: boolean;
}

export interface Summary {
  /** Runs on scenarios where something was actually broken. */
  injected: { graded: number; invalid: number; unresolved: number; correct: number; trapped: number };
  /** Runs on a healthy cluster, where the only right answer is "I don't know". */
  control: { graded: number; invalid: number; confidentAnswers: number };
  invalidRate: number;
  /** How often it will commit to an answer at all, on real faults. */
  answerRate: number | null;
  /**
   * Answer rate split by whether the root cause is a Kubernetes object.
   *
   * These two classes are not the same measurement and averaging them hides
   * the interesting result. When the cause is a resource, naming it is most of
   * the answer and the deterministic scorer decides nearly everything. When it
   * is a value inside a process, the object decision separates barely more
   * than "the database or its client", and everything that makes the answer
   * actionable is prose a judge grades.
   *
   * The failure this exposes: a gate that answers most resource faults and
   * almost none of the others. That is the class the fault library was
   * extended to cover, and one blended number would report it as mild.
   */
  answerRateByClass: { k8sObject: number | null; inProcess: number | null };
  /** When it does commit, how often it is right. */
  precision: number | null;
  /** How often it invents a cause on a cluster where nothing was wrong. */
  falseAlarmRate: number | null;
  /**
   * Why the rates above are null. Empty means they may be published.
   * Non-empty means printing a percentage anyway is a decision to mislead.
   */
  withheld: string[];
}

export interface PublishThresholds {
  invalidRateCeiling: number;
  minGraded: number;
  /** Largest share of the graded runs any one scenario may contribute. */
  maxScenarioShare: number;
  /** Below this, precision describes a product that mostly does not answer. */
  minAnswerRate: number;
}

export const DEFAULT_THRESHOLDS: PublishThresholds = {
  invalidRateCeiling: 0.15,
  minGraded: 20,
  maxScenarioShare: 0.25,
  minAnswerRate: 0.3,
};

/** Mean of per-scenario rates, so a cheap scenario run often cannot dominate. */
function macroAverage(runs: RunOutcome[], numerator: (r: RunOutcome[]) => number, denominator: (r: RunOutcome[]) => number): number | null {
  const byScenario = new Map<string, RunOutcome[]>();
  for (const r of runs) byScenario.set(r.scenarioId, [...(byScenario.get(r.scenarioId) ?? []), r]);
  const rates = [...byScenario.values()]
    .map((rs) => ({ n: denominator(rs), x: numerator(rs) }))
    .filter((r) => r.n > 0)
    .map((r) => r.x / r.n);
  return rates.length === 0 ? null : rates.reduce((a, b) => a + b, 0) / rates.length;
}

/**
 * Aggregate a night's runs into numbers that can be said out loud.
 *
 * Three decisions here matter more than the arithmetic.
 *
 * **Controls are counted separately.** A healthy-cluster run can only come
 * back unresolved or wrong, so folding controls into one denominator lets
 * anyone move the safety number by adding more of them — and controls are the
 * cheapest runs there are, with nothing to inject and nothing to revert. In a
 * worked example, sixteen controls took a 37.5% confidently-wrong rate down to
 * 12.5% without the product changing at all.
 *
 * **Accuracy is split into two numbers, not one.** `rcaAt1` alone cannot tell
 * a reckless product from a mute one: a gate tightened until it never answers
 * scores zero confidently-wrong and looks safe. `answerRate` and `precision`
 * multiply back to the same figure but make the failure legible — over-tight
 * shows as `answerRate` collapsing while `precision` holds.
 *
 * **Numbers are withheld rather than qualified.** A percentage with a caveat
 * beside it gets quoted without the caveat. If the run cannot support a rate,
 * this returns null and says why, and the report prints counts instead.
 */
export function summarize(
  runs: RunOutcome[],
  thresholds: PublishThresholds = DEFAULT_THRESHOLDS,
  /**
   * False when the run had no mechanism judge.
   *
   * Without one no run can reach CORRECT, so precision computes to 0 — and
   * "0% precision" reads as "it is always wrong" when it means "we did not
   * grade that". Withholding it is the same rule applied to ourselves as to
   * every other number here.
   */
  mechanismsGraded = true,
): Summary {
  const graded = runs.filter((r) => r.outcome !== 'INVALID');
  const invalidRate = runs.length === 0 ? 0 : runs.filter((r) => r.outcome === 'INVALID').length / runs.length;

  const inj = graded.filter((r) => r.kind === 'injected');
  const ctl = graded.filter((r) => r.kind === 'control');
  const count = (rs: RunOutcome[], o: Outcome) => rs.filter((r) => r.outcome === o).length;

  const withheld: string[] = [];
  if (invalidRate > thresholds.invalidRateCeiling) {
    withheld.push(
      `${(invalidRate * 100).toFixed(0)}% of runs could not be graded, so the harness failed rather than the product`,
    );
  }
  if (inj.length < thresholds.minGraded) {
    withheld.push(
      `${inj.length} graded runs on real faults is below the floor of ${thresholds.minGraded}; a percentage over this many is noise`,
    );
  }
  const shares = new Map<string, number>();
  for (const r of inj) shares.set(r.scenarioId, (shares.get(r.scenarioId) ?? 0) + 1);
  const dominant = [...shares.entries()].find(([, n]) => inj.length > 0 && n / inj.length > thresholds.maxScenarioShare);
  if (dominant) {
    withheld.push(
      `${dominant[0]} is ${((dominant[1] / inj.length) * 100).toFixed(0)}% of the graded runs, so any rate is mostly that one scenario's rate`,
    );
  }

  const answered = (rs: RunOutcome[]) =>
    macroAverage(rs, (g) => g.filter((r) => r.outcome !== 'UNRESOLVED').length, (g) => g.length);
  const answerRate = answered(inj);
  if (answerRate !== null && answerRate < thresholds.minAnswerRate) {
    withheld.push(
      `the gate declined on ${((1 - answerRate) * 100).toFixed(0)}% of real faults; precision over the remainder describes a product that mostly does not answer`,
    );
  }

  if (!mechanismsGraded) {
    withheld.push(
      'mechanisms were not graded (no judge configured), so no run can be correct and precision '
      + 'would read as 0% rather than as unmeasured',
    );
  }

  const publish = withheld.length === 0;
  return {
    injected: {
      graded: inj.length,
      invalid: runs.filter((r) => r.kind === 'injected' && r.outcome === 'INVALID').length,
      unresolved: count(inj, 'UNRESOLVED'),
      correct: count(inj, 'CORRECT'),
      trapped: count(inj, 'TRAPPED'),
    },
    control: {
      graded: ctl.length,
      invalid: runs.filter((r) => r.kind === 'control' && r.outcome === 'INVALID').length,
      confidentAnswers: ctl.filter((r) => r.confidentlyWrong).length,
    },
    invalidRate,
    // answerRate survives the withholding: it is the number that explains why
    // the others are missing, and hiding it would hide the diagnosis too.
    answerRate,
    answerRateByClass: {
      k8sObject: answered(inj.filter((r) => !r.rootCauseIsNotK8sObject)),
      inProcess: answered(inj.filter((r) => r.rootCauseIsNotK8sObject)),
    },
    precision: publish
      ? macroAverage(inj, (rs) => count(rs, 'CORRECT'), (rs) => rs.filter((r) => r.outcome !== 'UNRESOLVED').length)
      : null,
    falseAlarmRate: publish
      ? macroAverage(ctl, (rs) => rs.filter((r) => r.confidentlyWrong).length, (rs) => rs.length)
      : null,
    withheld,
  };
}
