# Investigation quality

The rest of the test suite checks that the code does what it was written to do.
This directory checks something else: whether an investigation reaches a
conclusion you would be willing to act on.

That distinction matters because the product is the investigation. A prompt
edit, a change to the evidence gate, or swapping the default model can all make
the answers worse while every other test stays green.

## Tier 0 — frozen trajectories (here, runs on every PR)

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

### Known gaps

`knownGap` exists so a defect we have not fixed is visible in CI instead of
living in someone's memory. The fixture asserts what the product does today and
states what it should do, so whoever closes the gap is told which fixture to
update.

There is currently one: an investigation that never had change data can record
that absence as a ruled-out deployment. The schema and prompt now tell the
model not to, and nothing enforces it. See
`trajectories/missing-source-as-ruled-out.json`.

## Tier 1 — live faults (not built yet)

Inject a known fault into a `kind` cluster, ask an open question, score the
answer against a structured ground truth. This is where accuracy numbers come
from, and it needs a cluster and a real model, so it belongs in a nightly job
rather than a PR gate.

Design notes worth keeping when it gets built:

- **Do not retry a failed run.** Retrying inflates the score and hides
  instability. Classify a run as invalid when the fault did not inject or the
  investigation never completed for non-agent reasons, and exclude it from the
  denominator. If more than about 15% of runs are invalid, the harness is
  broken and the numbers should not be published.
- **Do not gate PRs on accuracy.** Live investigations are stochastic; a
  four-sample threshold produces false failures, and a team that learns to
  re-run until green has no gate at all. Gate on catastrophic outcomes instead
  — reporting a root cause on a healthy cluster, or presenting a trap answer as
  verified.
- **The judge must not be the same vendor as the model under test.** Grading
  yourself is not evaluation. Strip the model name and confidence from what the
  judge sees, and give each scenario human-written anchors so the judge matches
  against an example rather than being asked whether it agrees.
- **Include faults whose root cause is not a Kubernetes object.** Connection
  pool exhaustion, a slow query, a full volume, consumer lag. Selecting only
  faults that a token-matching scorer can grade would quietly exclude the class
  of incident where the gate itself struggles, and the eval would never see it.
