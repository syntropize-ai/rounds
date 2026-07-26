# Tier-1 live-fault results

Model under test: `deepseek-v4-pro` · judge: `google/gemini-2.5-flash`
1 scenarios × 1 runs · 1 graded on real faults, 0 on a healthy cluster, 0 excluded

**No rates published.**

- 1 graded runs on real faults is below the floor of 20; a percentage over this many is noise
- bookinfo-reviews-v2-latency is 100% of the graded runs, so any rate is mostly that one scenario's rate
- the gate declined on 100% of real faults; precision over the remainder describes a product that mostly does not answer

| Metric | Value | What it means |
|---|---|---|
| Answer rate | 0% | how often it committed to a cause on a real fault |
| Precision | — | of the times it committed, how often it was right |
| False alarm rate | — | how often it invented a cause on a healthy cluster |
| — on faults that are a Kubernetes object | 0% | answer rate, resource faults only |
| — on faults that are not | — | answer rate, a value inside a process |

The last two are split because they are not one measurement. When the cause is a
resource, naming it is most of the answer. When it is a value inside a process, the
object decision separates little more than "the database or its client" and the rest
is prose. A gate that answers most resource faults and almost none of the others is
the result this split exists to show.

Answer rate and precision are separate on purpose. A gate tightened until it never
commits scores a perfect false-alarm rate and is useless; that shows here as answer
rate collapsing while precision holds.

| Count | |
|---|---|
| Correct | 0 |
| Trapped — took the plausible neighbour | 0 |
| Declined to conclude | 1 |
| Confident causes on a healthy cluster | 0 |

Scenario mix: 0 of 1 faults have a root cause that is not a
Kubernetes object. A library that drifts toward zero here is grading name-matching
rather than diagnosis, because a resource name is all a token scorer needs.

## Every run

| Scenario | # | Outcome | Reported | Eliminated something real | Why |
|---|---|---|---|---|---|
| bookinfo-reviews-v2-latency | 1 | UNRESOLVED | — | — | no investigation was opened |