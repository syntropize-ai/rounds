# Investigation quality

The rest of the test suite checks that the code does what it was written to do.
This directory checks something else: whether an investigation reaches a
conclusion you would be willing to act on.

That distinction matters because the product is the investigation. A prompt
edit, a change to the evidence gate, or swapping the default model can all make
the answers worse while every other test stays green.

**There are no accuracy numbers yet.** Tier 1 has been built but not run at a
size that supports a percentage. Anything in this repo that quotes one is
wrong; see [What we refuse to print](#what-we-refuse-to-print).

## Tier 0 — frozen trajectories (runs on every PR)

A trajectory is a recording of what an agent did: the read calls that
executed, the checks it recorded, and the claim it finished with. Replaying one
through the real handler and the real gate is a pure function — no cluster, no
API key, no network, no flake.

```bash
npx vitest run tests/eval
```

What this catches:

- the evidence gate getting looser or stricter without anyone deciding to
- a refactor making it possible again to satisfy the gate without doing the work
- prompt or schema changes that break the structured contract the gate reads

What it cannot catch: whether a live agent, given a real broken cluster, finds
the real fault. That needs Tier 1.

### Adding a trajectory

Drop a JSON file in `trajectories/`. Prefer real runs — say in `note` where it
came from, and keep the numbers as they actually were. Invented trajectories
are fine for adversarial cases, where the point is a shape rather than a
measurement.

| Field | Meaning |
|---|---|
| `reads` | read-tool calls that actually ran, by family. A check must be backed by one. |
| `checks` | recorded in order, through the real handler |
| `claim` | the completion claim, put through the real gate |
| `expect` | `passed`, `unresolved`, or `rejected-at-record` |
| `why` | what breaks if this expectation changes — shown on failure |
| `knownGap` | present when the fixture pins behaviour we believe is wrong |

`knownGap` exists so a defect we have not fixed is visible in CI instead of
living in someone's memory. There are none open.

## Tier 1 — live faults (built; nightly, not a PR gate)

Inject a known fault into a live cluster, ask the question an operator would
ask, and score the answer against a ground truth written when the fault was
designed.

```bash
ROUNDS_EVAL_URL=http://127.0.0.1:3000 ROUNDS_EVAL_TOKEN=... \
ROUNDS_EVAL_MODEL=claude-opus-4-8 \
ROUNDS_EVAL_JUDGE_MODEL=deepseek-chat \
ROUNDS_EVAL_JUDGE_URL=https://api.deepseek.com/v1/chat/completions \
ROUNDS_EVAL_JUDGE_KEY=... \
npx tsx tests/eval/tier1/run.ts --repeats 7
```

It drives the product through `POST /api/chat` — the same path a person uses.
There is an internal entry point that would be faster and far less flaky, and
using it would stop measuring the product: whether the agent decides to open an
investigation at all, from an ordinary sentence, is part of what is graded.

The parts that decide what a number means are pure and unit-tested, so they run
on every PR alongside Tier 0: `scoring/score.ts` (what counts as correct),
`tier1/report.ts` (what counts as a run), `tier1/judge.ts` (how the mechanism is
graded), and `tier1/library.test.ts` (properties the fault library must hold).

### How an answer is scored

The root cause is split in two, and only one half reaches a judge.

`rootCause.object` is not really free text — it refers to a thing we chose when
we designed the fault. That decision is made in code, deterministically, and a
judge never sees it. It cannot promote a wrong object into a correct answer;
it can only confirm or downgrade one that is already right. Without that split,
a model that argues well for the wrong service can talk its way to a pass, and
that single failure would make every number here worthless.

The mechanism — one sentence of genuine prose — is what the judge grades,
against human-written anchors, from a **different vendor** than the model under
test. The graded sentence is stripped of identity, confidence and anything
addressed to a reader before the judge sees it: it was written by a model
prompted to convince an operator, and the judge is now the operator.

Outcomes: `CORRECT`, `PARTIAL`, `WRONG`, `TRAPPED` (took the plausible
neighbour the fault invites), `UNRESOLVED` (declined to conclude), `INVALID`.

### Three numbers, not one

| number | definition |
|---|---|
| **answer rate** | of real faults, how often it committed to a cause at all |
| **precision** | of the times it committed, how often it was right |
| **false alarm rate** | of healthy-cluster runs, how often it invented a cause |

Accuracy alone cannot tell a reckless product from a mute one. A gate tightened
until it never answers scores zero confidently-wrong and reads as safe; that
shows up here as answer rate collapsing while precision holds. The two multiply
back to plain accuracy, so nothing is lost by splitting them.

Healthy-cluster runs are counted in their **own cohort**. Folding them into one
denominator makes adding control runs — the cheapest runs there are, nothing to
inject and nothing to revert — the easiest way to improve the safety number
without touching the product. In a worked example, sixteen of them took a 37.5%
confidently-wrong rate down to 12.5% with no change to anything.

Scenarios are weighted equally, not by how often they ran, because cheap
scenarios get run more and would otherwise set the headline figure.

### What we refuse to print

`summarize` returns `null` for a rate and states why, rather than printing a
number with a caveat next to it — a percentage with a caveat gets quoted
without the caveat. Rates are withheld when:

- more than 15% of runs could not be graded (the harness failed, not the product)
- fewer than 20 graded runs on real faults
- any one scenario is more than a quarter of them (that is its rate, not the product's)
- the answer rate is under 30% (precision over the remainder describes a product that mostly does not answer)

**Do not retry a failed run.** Retrying inflates the score and hides
instability. A run is `INVALID` only when we cannot tell what the product would
have done — the fault never became observable, the API was unreachable. Every
failure that is the product's, including refusing to investigate, crashing, and
running out of time, is graded as `UNRESOLVED` and stays in the denominator.
Moving that line is the easiest way to delete a product's worst runs.

**Do not gate PRs on accuracy.** Live investigations are stochastic; a
small-sample threshold produces false failures, and a team that learns to
re-run until green has no gate at all. Gate on catastrophic outcomes instead —
a confident root cause on a healthy cluster, or a trap answer presented as
verified.

**What a nightly run can and cannot detect.** At roughly 24 graded runs the
95% interval on a rate near 60% is about ±18 points. That is enough to catch a
catastrophic collapse and nothing else; detecting a 10-point regression needs
hundreds of runs per arm. Night-to-night deltas are not evidence and should not
be printed as such — an accuracy claim needs a dedicated run at a size decided
before it starts.

### Adding a scenario

Implement `Scenario` in `tier1/scenarios/`. Write it against a live cluster and
run `inject → confirmInjected → revert → confirmReverted` yourself before
committing; a scenario that has never actually injected will report `INVALID`
all night and quietly shrink the denominator.

`confirmInjected` must prove the fault is visible **through the product's own
data sources**, not that `kubectl apply` succeeded. A cluster that looks healthy
to Prometheus makes every investigation look appropriately humble, and the run
scores as a well-earned shrug.

Two properties `library.test.ts` enforces, both learned the hard way:

- **The answer must not appear in a resource name the injection creates.** A
  fault called `eval-reviews-v2-latency` is solved by `kubectl get virtualservice`.
- **The question must not name the fault.** It is what an operator would say,
  and an operator who already knows which service is broken does not need an
  investigation.

**Keep faults whose root cause is not a Kubernetes object** — connection pool
exhaustion, a slow query, a full volume, consumer lag. A library drifts toward
what is easy to grade, and what is easy to grade is a resource name. That drift
silently excludes the class of incident where the evidence gate itself
struggles, and the numbers never show it. `library.test.ts` fails if the count
reaches zero.
