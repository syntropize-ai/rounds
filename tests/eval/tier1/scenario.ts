/**
 * The contract every live fault implements.
 *
 * A scenario is a thing we break on purpose, plus everything needed to decide
 * afterwards whether the investigation found it. The four phases are separate
 * because each can fail in a way that means something different:
 *
 * - `inject` failing means the run never started. Not a wrong answer.
 * - `confirmInjected` failing means we broke nothing, or broke it somewhere the
 *   product cannot see. Also not a wrong answer — and the most dangerous case,
 *   because a healthy cluster makes every investigation look appropriately
 *   humble and the eval scores a false pass.
 * - `revert` failing leaves the cluster dirty and poisons every later scenario,
 *   so the runner stops rather than continuing into garbage.
 * - only what happens between them is graded.
 *
 * Scenarios are written against a live cluster and are expected to be run
 * against one while being written. A scenario that has never actually injected
 * is a scenario that will report INVALID all night.
 */

import type { GroundTruth } from '../scoring/score.js';

export interface Scenario {
  id: string;
  /**
   * Whether anything is actually broken.
   *
   * Controls answer a different question — "does it invent a cause when there
   * is none?" — and are summarised in their own cohort. Sharing a denominator
   * would make adding control runs, the cheapest runs there are, the easiest
   * way to improve the safety number without changing the product.
   */
  kind: 'injected' | 'control';
  /** One line, for the run log. */
  title: string;
  /**
   * Why this fault is here — specifically, what it tests that the others do
   * not. If you cannot answer that, the scenario is padding the denominator.
   */
  rationale: string;
  /**
   * True when the root cause is not a Kubernetes object.
   *
   * Tracked because a scenario library drifts toward faults that are easy to
   * grade, and those are exactly the faults where a token match on a resource
   * name is enough. The runner reports the split so the drift is visible in
   * the numbers rather than only in the code.
   */
  rootCauseIsNotK8sObject: boolean;
  /** What an operator would actually ask. Never names the fault. */
  question: string;
  truth: GroundTruth;
  /**
   * How long the symptom needs to be visible before asking. Metrics have a
   * scrape interval; asking too early evaluates an empty dashboard.
   */
  soakMs: number;
  inject(): Promise<void>;
  /**
   * Prove the fault is live and observable *through the product's own data
   * sources* — not just that kubectl accepted the manifest. Return false and
   * the run is INVALID and excluded from the denominator.
   */
  confirmInjected(): Promise<boolean>;
  revert(): Promise<void>;
  /**
   * Prove the cluster is back. Runs after `revert`; a false halts the whole
   * suite, because every scenario after this one would be scored against a
   * cluster that is still broken in a way nobody recorded.
   */
  confirmReverted(): Promise<boolean>;
}

/**
 * The control: nothing is broken.
 *
 * Every eval needs one. Without it a model that always answers "the database
 * is overloaded" can score respectably on a library where the database is
 * often overloaded, and nothing in the harness would notice. Here the only
 * correct outcome is UNRESOLVED, and any confident root cause is the
 * catastrophic failure the PR gate actually watches for.
 *
 * `objectMustMatch: []` makes `namesObject` return false for every possible
 * answer, so naming anything at all scores WRONG and confidently-wrong.
 */
export const HEALTHY_CONTROL_TRUTH: GroundTruth = {
  id: 'healthy-control',
  objectMustMatch: [],
  mechanism: 'Nothing was wrong. The correct answer is that no root cause was established.',
};
