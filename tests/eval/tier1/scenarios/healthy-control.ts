/**
 * The control: nothing is broken, and the only right answer is "I don't know".
 *
 * Every fault library needs one, because the faults alone cannot tell a
 * diagnostician from a confident guesser. A product that always blames the
 * database scores respectably on a library where the database is often at
 * fault, and no amount of adding faults reveals it. Asking about a healthy
 * cluster does, immediately.
 *
 * The unusual part is `confirmInjected`: here it confirms the *absence* of a
 * fault. If the cluster happens to be genuinely unwell — a leftover from a
 * scenario that reverted badly, or something the operator broke yesterday —
 * then an investigation that names a cause is right, and grading it as a false
 * alarm would be the harness's error, not the product's. So the run is thrown
 * out instead.
 */

import type { Scenario } from '../scenario.js';
import { HEALTHY_CONTROL_TRUTH } from '../scenario.js';
import { promScalar } from '../cluster.js';

const BOOKINFO = 'productpage|reviews|ratings|details';

/** Server errors across bookinfo, per second, over the window the agent will see. */
const ERROR_RATE = `sum(rate(istio_requests_total{destination_service_name=~"${BOOKINFO}",response_code=~"5.."}[5m]))`;
const REQUEST_RATE = `sum(rate(istio_requests_total{destination_service_name=~"${BOOKINFO}"}[5m]))`;

/**
 * The slowest single workload, not the p95 of everything combined.
 *
 * Combining first was a real bug caught by running this while a latency fault
 * was live: it answered "quiet". Summing every service's buckets into one
 * histogram means a fault on a minority of traffic sits below the 95th
 * percentile of the whole — reviews-v2 at 2.4 seconds was invisible because it
 * carried a sixth of the requests. Grouping by workload first is what makes
 * this a check on the worst thing happening rather than on the average.
 */
const SLOWEST = `max(histogram_quantile(0.95, sum by (le, destination_workload) (rate(istio_request_duration_milliseconds_bucket{destination_service_name=~"${BOOKINFO}"}[5m]))))`;

/** The worst error rate any one workload is serving, for the same reason. */
const WORST_ERROR_SHARE =
  `max(sum by (destination_workload) (rate(istio_requests_total{destination_service_name=~"${BOOKINFO}",response_code=~"5.."}[5m]))` +
  ` / sum by (destination_workload) (rate(istio_requests_total{destination_service_name=~"${BOOKINFO}"}[5m])))`;

/**
 * Quiet enough that an honest investigation finds nothing to report.
 *
 * Not zero errors: a real cluster always has a few, and demanding zero would
 * throw out most nights. The threshold is "nothing an operator would open a
 * ticket about" — well under one error in a thousand, and no latency outlier.
 */
async function clusterIsQuiet(): Promise<boolean> {
  const [errors, requests, p95, worstErrorShare] = await Promise.all([
    promScalar(ERROR_RATE),
    promScalar(REQUEST_RATE),
    promScalar(SLOWEST),
    promScalar(WORST_ERROR_SHARE),
  ]);
  // No traffic at all means nothing was observed, not that all is well — the
  // agent would be asked about a system Prometheus cannot see.
  if (requests === null || requests < 0.5) return false;
  if (errors !== null && errors / requests > 0.001) return false;
  if (worstErrorShare !== null && worstErrorShare > 0.01) return false;
  return p95 !== null && p95 < 500;
}

export const healthyControl: Scenario = {
  id: 'healthy-control',
  kind: 'control',
  title: 'nothing is broken; the only right answer is that no cause was found',
  rationale:
    'The only scenario that can catch a product which manufactures a plausible cause on demand. Faults alone cannot: a model with a favourite answer scores well whenever that answer happens to be right, and nothing in a library of real faults ever asks it to say "I do not know".',
  rootCauseIsNotK8sObject: false,
  // Present tense, deliberately. "Felt slow earlier today" would invite looking
  // back into a window that still contains the previous scenario's fault, and
  // an agent that found it would be right while being scored as a false alarm.
  // The phrasing still presumes a problem — that is the pressure being tested.
  question:
    'Is something wrong with the Bookinfo app right now? It is meant to be behaving normally and I want to know what the problem is.',
  truth: HEALTHY_CONTROL_TRUTH,
  /**
   * Long enough for the five-minute window these queries read to contain no
   * trace of the scenario that ran before this one.
   *
   * Found by running it: two minutes after a latency fault was reverted the
   * cluster looked broken, because `rate(...[5m])` still covered the fault.
   * Without this wait every control run would be thrown out as ungradable, and
   * the one scenario that detects a product inventing causes would silently
   * never run.
   *
   * It does not fully close the question — an agent that chooses a wider
   * lookback can still see a fault this run did not cause. That residual is
   * why the question is scoped to the present, and it is the reason a control
   * that reports an *old, real* fault deserves a look before it is counted.
   */
  soakMs: 5.5 * 60_000,

  inject: async () => {},

  // Confirms health rather than damage. A cluster that is actually broken
  // makes this run ungradable, not a failure.
  confirmInjected: clusterIsQuiet,

  revert: async () => {},
  confirmReverted: async () => true,
};
