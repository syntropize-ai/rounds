/**
 * Faults whose root cause is a value or a condition inside a process.
 *
 * Every other fault in this library breaks a Kubernetes object — a VirtualService,
 * an image tag. Those are convenient to grade because the answer *is* a resource
 * name, and a scorer that matches resource names settles them without a judge.
 * That convenience is a selection pressure: a library assembled from what grades
 * cleanly ends up containing only faults where naming the object is the answer,
 * and the class of incident where the evidence gate actually struggles never
 * appears in the numbers.
 *
 * The two here fall outside it. In both, every Deployment is well-formed, every
 * probe passes, `kubectl get pods` reads Running and Ready, and no object spec
 * anywhere contains the fault. What is wrong is one integer inside a database
 * process, and a filesystem with no space left. Neither has a resource name, so
 * both are graded against the workload that owns the bad value — read the
 * comment on each ground truth for why that is the least-bad option and what it
 * gets wrong, before trusting any number these produce.
 *
 * Everything lives in its own namespace, which revert deletes outright. That is
 * deliberate: these scenarios ship a database and three workloads, and a partial
 * cleanup in a shared namespace is how a later scenario ends up scored against
 * someone else's fault.
 *
 * One consequence of that namespace, worth knowing before reading any result:
 * promtail on this cluster only tails `/var/log/pods/default_*`, so nothing
 * these workloads log ever reaches Loki. The line that names the cause outright
 * — `sorry, too many clients already`, `No space left on device` — exists only
 * in `kubectl logs`. Both confirm steps therefore go through Prometheus, and an
 * investigation that reaches the right answer here has to have used the cluster
 * shell to get there. If runs on these two come back UNRESOLVED while the mesh
 * faults pass, suspect that before suspecting the model: the gate wants two
 * signal types and one of the three is simply not wired up for this namespace.
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { kubectl, applyManifest, promUntil } from '../cluster.js';
import type { Scenario } from '../scenario.js';

const NS = 'rounds-eval';
const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');

/** Prometheus `global.scrape_interval` on the eval cluster. */
const SCRAPE_MS = 15_000;

/**
 * Pods have to schedule, pull, pass readiness and then be scraped twice before
 * any counter here is non-zero. Both faults start the moment the process does,
 * so there is no rate window to fill — only the scrape to wait for.
 */
const SOAK_MS = 4 * SCRAPE_MS;

/** Budget per confirm condition. Generous; it is only spent when something is wrong. */
const CONFIRM_BUDGET_MS = 2 * 60_000;

async function applyFixture(file: string, deployments: string[]): Promise<void> {
  await applyManifest(await readFile(path.join(FIXTURES, file), 'utf8'));
  for (const deployment of deployments) {
    await kubectl('-n', NS, 'rollout', 'status', `deploy/${deployment}`, '--timeout=300s');
  }
}

/** Holds once the query returns a single sample above `floor`. */
const above = (query: string, floor: number): Promise<boolean> =>
  promUntil(query, (value) => value !== null && value > floor, { timeoutMs: CONFIRM_BUDGET_MS, intervalMs: SCRAPE_MS });

/**
 * Both faults are defined as much by what they do not do. A crashlooping or
 * unready pod would put the answer back in cluster state, where every other
 * scenario already lives — so a pod that is not Ready means this is no longer
 * the fault being claimed, and the run is invalid rather than merely unlucky.
 */
async function everyPodReady(): Promise<boolean> {
  const stdout = await kubectl(
    '-n', NS, 'get', 'pods',
    '-o', 'jsonpath={range .items[*]}{.status.conditions[?(@.type=="Ready")].status}{"\\n"}{end}',
  );
  const pods = stdout.split('\n').filter((line) => line.trim().length > 0);
  return pods.length > 0 && pods.every((status) => status.trim() === 'True');
}

const dropNamespace = (): Promise<string> =>
  kubectl('delete', 'namespace', NS, '--ignore-not-found', '--wait=true', '--timeout=300s');

/** The namespace is the unit of cleanup, so its absence is the whole revert check. */
async function namespaceGone(): Promise<boolean> {
  const stdout = await kubectl('get', 'namespaces', '-o', 'name');
  return !stdout.split('\n').map((line) => line.trim()).includes(`namespace/${NS}`);
}

const connectionPoolExhausted: Scenario = {
  id: 'connection-pool-exhausted',
  kind: 'injected',
  title: 'orders-api 503s because orders-db has fewer connection slots than the fleet holds',
  rationale:
    'The root cause is a single integer inside a running Postgres. No object spec is wrong, nothing restarts, no pod leaves Ready — so an investigation that works by diffing cluster state against a healthy baseline finds nothing at all, and one that stops at the first workload with errors on its page stops at the client. It is also the only fault here where the failing workload and the responsible one are both healthy by every Kubernetes measure.',
  rootCauseIsNotK8sObject: true,
  question:
    'Order submissions in the rounds-eval namespace have been failing on and off for the last half hour — customers get an error on roughly a third of attempts and a retry usually works. Every pod is Running and nothing was deployed today. What is causing it?',
  truth: {
    id: 'connection-pool-exhausted',
    /*
     * The crux of this scenario, and the least satisfying part of it.
     *
     * The root cause is `max_connections=10`, a value that exists only in the
     * memory of a running process. It has no resource name. `orders-db` is the
     * nearest thing to one: it is where the value can be changed, which is the
     * bar the product's own evidence gate sets for `rootCause.object` ("must
     * name the specific repair target").
     *
     * Matching mechanism vocabulary instead — `connection` + `limit`, say — was
     * tried and rejected for two reasons. The tokenizer does no stemming, so
     * `connection` and `connections` are different tokens and a correct answer
     * would pass or fail on a plural. Worse, it disarms the trap: the wrong
     * answer this fault invites is "orders-api's pool is too small", which is
     * written in exactly the same vocabulary as the true cause. `hitsTrap` only
     * fires when the report misses `objectMustMatch`, so a vocabulary match
     * would score the trap answer as correct and quietly drive the TRAPPED
     * count to zero. A check that credits the answer it exists to catch is
     * worse than a blunt one.
     *
     * What `['orders-db']` wrongly CREDITS: any confident answer that blames the
     * database for anything at all — "orders-db is CPU starved", "orders-db is
     * deadlocked", "orders-db restarted". Each reaches PARTIAL on the object
     * check, and only the judge, reading one sentence of prose, separates them
     * from the real mechanism. The deterministic half of the scorer resolves
     * about one bit here — database or client — where on a Kubernetes-object
     * fault it resolves the entire answer.
     *
     * What it wrongly REJECTS: a fully correct answer phrased without the
     * workload name ("the Postgres connection limit is set to 10"), and one
     * that writes "the orders database", since `db` is not a token of
     * `database`.
     *
     * The trap is the harshest call in this file and deserves saying out loud:
     * "orders-api holds too many connections" describes the same fault from the
     * other end, and shrinking the pool would genuinely stop the 503s — yet an
     * answer naming only orders-api scores TRAPPED and confidently wrong. That
     * is deliberate. It sends an operator to change the client while the server
     * goes on refusing every other caller at 7 slots. An answer that names both
     * workloads matches `objectMustMatch` and is scored on that, not the trap.
     *
     * `field` records what is actually wrong. `score()` never reads
     * `GroundTruth.field` today, so nothing below the judge checks it; it is set
     * so that the day the scorer does, this fault does not need rewriting.
     */
    objectMustMatch: ['orders-db'],
    trapTokens: ['orders-api'],
    field: 'max_connections',
    mechanism:
      'orders-db runs with max_connections=10 and the default superuser_reserved_connections=3, leaving 7 slots for the application role. The 8 orders-api replicas each hold a pool of 2, demanding 16. The first 7 are granted and every later attempt is refused with SQLSTATE 53300, so the replicas that hold no connection return 503 for every request they receive. Nothing in Kubernetes is misconfigured and no pod leaves Ready.',
    shouldRuleOut: [
      'a bad rollout or recent deployment',
      'CPU or memory saturation on orders-api or orders-db',
      'a bug in the orders-api application code',
      'network failure between orders-api and orders-db',
    ],
  },
  soakMs: SOAK_MS,

  async inject() {
    await applyFixture('connection-pool-exhausted.yaml', ['orders-db', 'orders-api', 'orders-load']);
  },

  /*
   * Four conditions, because any one of them alone is also what a healthy or a
   * half-injected cluster can look like. Together they say: the client is
   * failing, the server is refusing connections, the limit that causes it is
   * low, and the mesh the product usually reads agrees.
   */
  confirmInjected: async () =>
    (await above('sum(orders_requests_total{result="db_unavailable"})', 0)) &&
    (await above('sum(db_connect_failures_total{sqlstate="53300"})', 0)) &&
    (await above('max(pg_settings_max_connections) < 16', 0)) &&
    (await above('sum(istio_requests_total{destination_workload="orders-api",response_code="503"})', 0)) &&
    (await everyPodReady()),

  async revert() {
    await dropNamespace();
  },

  confirmReverted: namespaceGone,
};

const diskFull: Scenario = {
  id: 'disk-full',
  kind: 'injected',
  title: 'ledger-api 5xxs because the volume behind ledger-store has no space left',
  rationale:
    'The root cause is a filesystem condition: it appears in no object spec and in no `kubectl get` output, because the volume is declared exactly as intended and the pod stays Ready — its health endpoint never writes. Like the connection-pool fault it separates the tier that fails from the tier at fault, but the evidence is a gauge nobody thinks to graph rather than an error counter.',
  rootCauseIsNotK8sObject: true,
  question:
    'The ledger API in the rounds-eval namespace started returning 5xx to its callers about ten minutes ago and has not recovered. Every pod reports Ready, there was no deploy, and nothing has restarted. What is going on?',
  truth: {
    id: 'disk-full',
    /*
     * The same compromise as connection-pool-exhausted, for the same reason.
     *
     * The root cause is that the filesystem mounted at /data has zero free
     * bytes. A filesystem is not a Kubernetes object and has no name to match
     * on; `ledger-store` owns it and is what an operator would act on, so it is
     * the object requirement.
     *
     * Matching `disk` or `space` instead was rejected on the same grounds as
     * before: the wrong answer this fault invites — that ledger-api is broken —
     * gets written in precisely those words ("ledger-api can't write"), so the
     * vocabulary does not separate the right answer from the wrong one and
     * would neutralise the trap.
     *
     * What `['ledger-store']` wrongly CREDITS: any confident answer blaming
     * ledger-store for anything — a slow disk, a crash, a lock, a bad deploy.
     * The object check cannot tell "ledger-store's volume is full" from
     * "ledger-store is broken"; only the judge can.
     *
     * What it wrongly REJECTS: "the data volume mounted at /data is full",
     * which is the most precise possible statement of the cause and names no
     * workload at all.
     */
    objectMustMatch: ['ledger-store'],
    trapTokens: ['ledger-api'],
    field: 'free space on the /data volume',
    mechanism:
      'The memory-backed emptyDir mounted at /data on ledger-store was filled to its 16Mi sizeLimit, so every append fails with ENOSPC and the store answers 507. ledger-api owns no storage and turns that into the 502s the caller sees. Usage never exceeds the limit, so kubelet does not evict, the pod stays Ready, and no object spec reflects the fault.',
    shouldRuleOut: [
      'a ledger-api regression or bad rollout',
      'ledger-store being down, restarting or unreachable',
      'CPU or memory pressure',
      'a network fault between the two tiers',
    ],
  },
  soakMs: SOAK_MS,

  async inject() {
    await applyFixture('disk-full.yaml', ['ledger-store', 'ledger-api', 'ledger-load']);
  },

  /*
   * The free-space gauge is the fault itself; the two counters are what an
   * operator would notice first. Confirming all three is what distinguishes
   * this fault from a store that is merely down — which would fail the same
   * caller-side check while the gauge stayed healthy.
   */
  confirmInjected: async () =>
    (await above('sum(api_requests_total{code="502"})', 0)) &&
    (await above('sum(ledger_writes_total{result="no_space"})', 0)) &&
    (await above('count(ledger_data_free_bytes < 4096)', 0)) &&
    (await everyPodReady()),

  async revert() {
    await dropNamespace();
  },

  confirmReverted: namespaceGone,
};

export { connectionPoolExhausted, diskFull };

export const inProcessScenarios: Scenario[] = [connectionPoolExhausted, diskFull];
