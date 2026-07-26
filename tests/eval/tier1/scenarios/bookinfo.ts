/**
 * Live faults against the Bookinfo mesh in the `default` namespace of the kind
 * cluster.
 *
 * Every fault here is reversible by construction: two are Istio
 * VirtualServices this file creates and deletes, and the third is a container
 * image swapped back to the value read off the live Deployment immediately
 * before injecting. Nothing edits a resource the cluster fixture shipped with,
 * so a crashed run leaves at most an orphaned VirtualService named in
 * `INJECTED_RESOURCE_NAMES`.
 *
 * Those names are deliberately opaque. A fault called `eval-reviews-v2-latency`
 * writes the answer into the cluster, and `kubectl get virtualservice` solves
 * the scenario without investigating anything.
 *
 * The confirm steps deliberately go through Prometheus rather than kubectl.
 * `kubectl apply` succeeding proves the API server accepted a manifest; it
 * proves nothing about whether istiod pushed the config, whether traffic is
 * flowing, or whether the product can see the result. A scenario that injects
 * into a mesh nobody is measuring scores a false pass, which is the failure
 * mode `confirmInjected` exists to prevent.
 */

import type { Scenario } from '../scenario.js';
import { kubectl, applyManifest, promScalar } from '../cluster.js';

const NS = 'default';

/**
 * Prometheus scrapes every 15s — the configured `global.scrape_interval`, and
 * confirmed against the live server: `prometheus_target_interval_length_seconds`
 * reports a p50 of 15.000038s, and a bookinfo pod target yields exactly 20
 * samples per 5 minutes.
 *
 * Every soak and poll below is expressed in multiples of this rather than a
 * round number, because a round number is a guess that happens to work until
 * somebody changes the scrape config.
 */
const SCRAPE_MS = 15_000;

/**
 * One rate window plus a scrape either side: the scrape that lands after the
 * fault starts, 60s of samples to fill `rate(...[1m])`, and the scrape that
 * closes the window. Asking earlier evaluates a rate computed over a mix of
 * healthy and broken samples, which understates the symptom.
 */
const SOAK_MS = 60_000 + 2 * SCRAPE_MS;

/** Pods have to terminate, be rescheduled and fail to pull before any of that. */
const SOAK_WITH_RESCHEDULE_MS = SOAK_MS + 4 * SCRAPE_MS;

/**
 * Poll a Prometheus-backed condition until it holds.
 *
 * Confirm steps cannot be a single read: whether the runner soaks before
 * calling them is not part of the `Scenario` contract, and a metric that is
 * one scrape away from being true is not a broken fault. Polling on the scrape
 * boundary makes the answer depend on the cluster rather than on call order.
 */
async function settles(check: () => Promise<boolean>, budgetMs: number): Promise<boolean> {
  const deadline = Date.now() + budgetMs;
  for (;;) {
    if (await check()) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((r) => setTimeout(r, SCRAPE_MS));
  }
}

const CONFIRM_BUDGET_MS = 3 * 60_000;

/** p95 latency in ms of requests *arriving at* a workload, as its own sidecar saw them. */
const inboundP95 = (workload: string) =>
  `histogram_quantile(0.95, sum by (le) (rate(istio_request_duration_milliseconds_bucket{reporter="destination",destination_workload="${workload}"}[1m])))`;

/**
 * Requests per second a caller sent to a service that came back with a given
 * status, as the *caller's* sidecar saw them. Both mesh faults below are
 * applied client-side, so the destination's own metrics never show them —
 * reading the source reporter is the only way to see the fault at all.
 *
 * `or vector(0)` keeps "the series went away" and "the series is flat" the
 * same answer, so a revert check is one comparison rather than a null branch.
 */
const callRate = (service: string, code: string) =>
  `sum(rate(istio_requests_total{reporter="source",destination_service_name="${service}",response_code="${code}"}[1m])) or vector(0)`;

async function above(query: string, threshold: number): Promise<boolean> {
  const v = await promScalar(query);
  return v !== null && v > threshold;
}

async function below(query: string, threshold: number): Promise<boolean> {
  const v = await promScalar(query);
  return v !== null && v < threshold;
}

/**
 * 2s, not 5s: productpage gives every downstream call a 3.0s timeout
 * (`productpage.py`), and crossing it turns a latency fault into an error
 * fault. Staying under it is what keeps this scenario in the "every pod is
 * Ready, every response is 200, and the service is still broken" class.
 */
const REVIEWS_V2_DELAY = '2s';

const reviewsV2Latency: Scenario = {
  id: 'bookinfo-reviews-v2-latency',
  kind: 'injected',
  title: 'reviews-v2 calls to ratings delayed 2s; every pod Ready, every response 200',
  rationale:
    'The only fault here with no error signal at all. Pods stay Ready, productpage keeps returning 200, and the sole evidence is a latency histogram split by version — so an investigation that reads health and status codes finds a clean cluster. It also separates the two reporters: from reviews-v2 the ratings call takes 2.4s, while ratings own sidecar records 0.5ms for the same requests.',
  rootCauseIsNotK8sObject: false,
  question:
    'About half of the requests to the Bookinfo product page are taking a couple of seconds to come back, and the other half are instant. Nothing is returning an error. What is going on?',
  truth: {
    id: 'bookinfo-reviews-v2-latency',
    objectMustMatch: ['reviews-v2'],
    // Naming the rule is the other honest answer: it is what an operator
    // deletes. The workload and the rule are opposite ends of the same fault,
    // and picking either one gets someone to the right place.
    alsoAccept: [['rounds-eval-fault-1']],
    trapTokens: ['ratings-v1', 'ratings'],
    field: 'spec.http[].fault.delay.fixedDelay',
    mechanism:
      'An Istio VirtualService injected a fixed 2s delay into calls made by reviews-v2 to ratings. Only the half of product page requests that the reviews traffic policy routes to reviews-v2 is slow; reviews-v3 is unaffected, and ratings itself served every request in under a millisecond.',
    shouldRuleOut: [
      'ratings-v1 being slow or overloaded',
      'reviews-v3',
      'productpage-v1 itself',
      'node or pod resource pressure',
    ],
  },
  soakMs: SOAK_MS,

  async inject() {
    await applyManifest(`
apiVersion: networking.istio.io/v1
kind: VirtualService
metadata:
  name: rounds-eval-fault-1
  namespace: ${NS}
spec:
  hosts:
  - ratings
  http:
  - match:
    - sourceLabels:
        app: reviews
        version: v2
    fault:
      delay:
        percentage:
          value: 100
        fixedDelay: ${REVIEWS_V2_DELAY}
    route:
    - destination:
        host: ratings
  # Istio 404s anything that matches no rule, so reviews-v3 needs an explicit
  # unfaulted route. Its presence is also what makes the scenario gradable:
  # without a healthy sibling on the same service there is nothing to compare
  # reviews-v2 against.
  - route:
    - destination:
        host: ratings
`);
  },

  // The comparison, not the absolute number, is the proof: reviews-v2 slow
  // while reviews-v3 stays fast is a fault scoped to one version, which a
  // cluster-wide slowdown would not produce.
  confirmInjected: () =>
    settles(
      async () =>
        (await above(inboundP95('reviews-v2'), 1500)) && (await below(inboundP95('reviews-v3'), 500)),
      CONFIRM_BUDGET_MS,
    ),

  async revert() {
    await kubectl('delete', 'vs', '-n', NS, 'rounds-eval-fault-1', '--ignore-not-found');
  },

  confirmReverted: () => settles(() => below(inboundP95('reviews-v2'), 500), CONFIRM_BUDGET_MS),
};

const ratings503: Scenario = {
  id: 'bookinfo-ratings-503',
  kind: 'injected',
  title: 'every call to ratings aborted with 503 in the caller sidecar',
  rationale:
    'The failure is one hop below where it is visible, and the workload it is named after never sees a request: ratings-v1 goes idle and perfectly healthy while its callers 503. Tests whether an investigation follows a source-reporter error rate to a service that has no errors of its own, rather than stopping at the first workload whose page looks wrong.',
  rootCauseIsNotK8sObject: false,
  // Says what a user sees, not what it is called. The visible symptom here is
  // a section of the page named after the very service that is the answer, so
  // quoting the page verbatim would hand over the ground truth and the run
  // would measure reading comprehension.
  question:
    'One block on the Bookinfo product page has stopped showing its content and says it is currently unavailable. The rest of the page loads normally and nothing is returning an error to the browser. What is going on?',
  truth: {
    id: 'bookinfo-ratings-503',
    // `ratings`, not `ratings-v1`: the workload is healthy and idle, so the
    // deployment is not the repair target. What is broken is the route to it.
    objectMustMatch: ['ratings'],
    alsoAccept: [['rounds-eval-fault-2']],
    trapTokens: ['reviews-v2', 'productpage-v1'],
    field: 'spec.http[].fault.abort.httpStatus',
    mechanism:
      'An Istio VirtualService aborted every call to the ratings service with a 503 in the calling sidecar. reviews-v2 and reviews-v3 degrade gracefully and still return 200, so the only error signal is the source-reported 503 rate on the ratings destination; ratings-v1 itself received no traffic and stayed healthy.',
    shouldRuleOut: [
      'reviews-v2 or reviews-v3 being broken',
      'productpage-v1',
      'ratings-v1 crashing, restarting or failing readiness',
    ],
  },
  soakMs: SOAK_MS,

  async inject() {
    await applyManifest(`
apiVersion: networking.istio.io/v1
kind: VirtualService
metadata:
  name: rounds-eval-fault-2
  namespace: ${NS}
spec:
  hosts:
  - ratings
  http:
  - fault:
      abort:
        percentage:
          value: 100
        httpStatus: 503
    route:
    - destination:
        host: ratings
`);
  },

  confirmInjected: () => settles(() => above(callRate('ratings', '503'), 0.1), CONFIRM_BUDGET_MS),

  async revert() {
    await kubectl('delete', 'vs', '-n', NS, 'rounds-eval-fault-2', '--ignore-not-found');
  },

  // Both halves matter. A zero 503 rate is also what a cluster with no traffic
  // looks like, and "the fault is gone" and "the workload is gone" must not be
  // the same answer.
  confirmReverted: () =>
    settles(
      async () =>
        (await below(callRate('ratings', '503'), 0.01)) && (await above(callRate('ratings', '200'), 0.1)),
      CONFIRM_BUDGET_MS,
    ),
};

/**
 * Read at inject time and restored at revert time. Hardcoding what the image
 * "should" be makes revert a second injection the day the fixture is bumped.
 */
let detailsOriginalImage: string | null = null;

const detailsBadImage: Scenario = {
  id: 'bookinfo-details-bad-image',
  kind: 'injected',
  title: 'details-v1 rolled onto a tag that does not exist',
  rationale:
    'The only fault whose evidence is in the workload API rather than in the mesh, and the only one where the broken pod is plainly broken. It is here as the easy end of the range: if an investigation cannot find an ImagePullBackOff it will not find anything else, and the trap is only that productpage-v1 is where a user notices.',
  rootCauseIsNotK8sObject: false,
  question:
    'The Bookinfo product page has been showing an error where the book details normally are. It started a few minutes ago and has not recovered. What is going on?',
  truth: {
    id: 'bookinfo-details-bad-image',
    objectMustMatch: ['details-v1'],
    trapTokens: ['productpage-v1', 'productpage'],
    field: 'spec.template.spec.containers[0].image',
    mechanism:
      'details-v1 was rolled onto a container image tag that does not exist in the registry. Its only replica was replaced by a pod stuck in ImagePullBackOff, leaving the details service with no endpoints, so productpage calls to details failed in its own sidecar with 503 and no healthy upstream.',
    shouldRuleOut: [
      'productpage-v1 being at fault',
      'a network policy or mesh configuration change',
      'the details container crashing on startup',
    ],
  },
  soakMs: SOAK_WITH_RESCHEDULE_MS,

  async inject() {
    detailsOriginalImage = (
      await kubectl(
        'get', 'deploy', '-n', NS, 'details-v1',
        '-o', 'jsonpath={.spec.template.spec.containers[0].image}',
      )
    ).trim();

    // Recreate, not the fixture's RollingUpdate. At one replica a 25%
    // maxUnavailable rounds down to zero, so the healthy pod is kept until the
    // new one is Ready — and it never is. The fault would inject, kubectl
    // would report success, and details would keep serving traffic with no
    // symptom anywhere. Recreate is what makes this fault observable at all.
    await kubectl(
      'patch', 'deploy', '-n', NS, 'details-v1', '--type', 'merge',
      '-p', JSON.stringify({ spec: { strategy: { type: 'Recreate', rollingUpdate: null } } }),
    );
    await kubectl(
      'set', 'image', '-n', NS, 'deploy/details-v1',
      `details=${detailsOriginalImage.replace(/:[^:]*$/, ':this-tag-does-not-exist')}`,
    );
  },

  confirmInjected: () =>
    settles(
      async () =>
        (await above(callRate('details', '503'), 0.1)) && (await below(callRate('details', '200'), 0.01)),
      CONFIRM_BUDGET_MS,
    ),

  async revert() {
    if (!detailsOriginalImage) throw new Error('revert called before inject recorded the original image');
    await kubectl('set', 'image', '-n', NS, 'deploy/details-v1', `details=${detailsOriginalImage}`);
    await kubectl(
      'patch', 'deploy', '-n', NS, 'details-v1', '--type', 'merge',
      '-p', JSON.stringify({
        spec: { strategy: { type: 'RollingUpdate', rollingUpdate: { maxSurge: '25%', maxUnavailable: '25%' } } },
      }),
    );
    await kubectl('rollout', 'status', '-n', NS, 'deploy/details-v1', '--timeout=180s');
  },

  confirmReverted: () =>
    settles(
      async () =>
        (await above(callRate('details', '200'), 0.1)) && (await below(callRate('details', '503'), 0.01)),
      CONFIRM_BUDGET_MS,
    ),
};

export const bookinfoScenarios: Scenario[] = [reviewsV2Latency, ratings503, detailsBadImage];
