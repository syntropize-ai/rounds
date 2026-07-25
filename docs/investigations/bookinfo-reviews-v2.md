# A real investigation, start to finish

This is the complete output of one investigation, run against a live cluster,
reproduced here without editing the findings. Every number was independently
verified against Prometheus afterwards; the verification is included so you can
check the checking.

It is here because "our AI finds root causes" is a claim anyone can make. This
is what the output actually looks like — including the parts that are weaker
than the marketing would suggest.

## The setup

A `kind` cluster running the Istio Bookinfo sample: `productpage`, `details`,
`ratings`, and three versions of `reviews`, with a traffic client generating
load. Prometheus scraping Istio telemetry. Rounds installed from the released
Helm chart, connected to that Prometheus, using DeepSeek as the model.

The relevant detail: **nothing looked wrong.**

```
$ kubectl get pods -n default
NAME                          READY   STATUS    RESTARTS   AGE
details-v1-6b79fb7d85-d7w4s   2/2     Running   2          47d
productpage-v1-7d47b66bfc     2/2     Running   2          59d
ratings-v1-5bb6998b55-67lvx   2/2     Running   2          54d
reviews-v1-7d457568f-cgzz7    2/2     Running   4          63d
reviews-v2-66c97ddb57-jr58d   2/2     Running   4          63d
reviews-v3-586d476db5-96lbx   2/2     Running   4          63d
```

Every pod ready. No restarts in flight, no crash loops, no pending. By the
usual first-look heuristics, this cluster is fine.

## The question

Asked in plain language, by someone who does not know PromQL:

> 我的系统现在有什么问题吗?我不太懂监控,请用简单的话告诉我
>
> *(Is anything wrong with my system? I don't really understand monitoring,
> please explain in simple terms.)*

No service named. No metric named. No time range.

## What it did

**83 seconds. 6 recorded checks. 2 signal types.**

The first thing it did was fail, and notice:

> 好的,系统里有很多数据。我先检查几个关键的健康指标,看看有没有问题。
> `metrics_query ×6 → 0 series returned`
>
> 看起来标准的 Kubernetes 节点/Pod 指标可能没有采集。让我看看实际有什么数据。
> `metrics_discover → ok`
>
> 找到了! 系统使用的是容器级别的指标。让我用正确的指标来检查。
> `metrics_query ×6 → 4 series returned`

This matters more than the final answer. The standard `kube-state-metrics`
series were not present in this cluster. Rather than reporting "no data" or
inventing numbers, it noticed the empty result, re-ran discovery, found
container-level and Istio metrics instead, and continued. A user who does not
know the difference between cAdvisor and kube-state-metrics never had to learn
it.

Then it found the fault:

> 发现重要线索! 让我再深入看看。

## The evidence trail

Recorded during the investigation, not reconstructed afterwards. `Supported`
means the data backed the hypothesis; `Ruled out` means the data contradicted
it.

| | Hypothesis | Query | Result | Verdict |
|---|---|---|---|---|
| **m1** | Services are returning HTTP errors | `sum(rate(istio_requests_total{response_code=~"5.*"}[5m])) > 0` | reviews: ~0.84 503/s, ~24% of requests. productpage, details, ratings all 200. | **Supported** |
| **m2** | One specific version of reviews is failing | `sum(rate(istio_requests_total{destination_service="reviews.default.svc.cluster.local"}[5m])) by (destination_version, response_code)` | v2: 0.91 OK + 0.80 503 (~47% error). v3: 1.72 OK, zero errors. | **Supported** |
| **m3** | Resource exhaustion is causing failures | `sum(rate(container_cpu_usage_seconds_total[5m])) by (container, namespace) * 100` | Total CPU ~0.66 cores. Every namespace low. | **Ruled out** |
| **m4** | Network failure is making the service unreachable | `sum(rate(container_network_receive_errors_total[5m])) by (namespace) > 0` | Zero receive errors. | **Ruled out** |
| **m5** | Latency is causing timeouts that surface as 503 | `histogram_quantile(0.99, sum(rate(istio_request_duration_milliseconds_bucket[5m])) by (le, destination_service))` | reviews p99 9.9ms, productpage 24.8ms. Both normal. | **Ruled out** |
| **m6** | Memory pressure is destabilising reviews | `sum(rate(container_memory_failures_total[5m])) > 0 by (namespace, container)` | Allocation failures exist but come from the load client (1143/s), not reviews. | **Inconclusive** |

The reasoning that made it useful, from m2:

> 503 错误仅来自 reviews v2(该版本依赖 ratings 服务),v3 完全正常(v3 不依赖 ratings)
> —— 说明问题可能是 reviews v2 调用 ratings 时出错。

Two versions of the same service, one failing and one not, differing in whether
they call `ratings` — so suspicion falls on that dependency.

## Where it landed, and where it was initially wrong

The first report proposed that `reviews-v2` was failing *because* its calls to
`ratings` were failing. That is the obvious reading, and it is wrong.

Asked to dig further, it checked the dependency directly and corrected itself:

> `response_flags` 是 "-" 对于这些 503。在 Istio 中,没有 response flag 的 503
> 通常意味着应用本身返回了 503,而不是传输层问题。

Then it named the actual cause:

> **reviews v2 应用代码有 Bug** —— 它的代码里硬写了约 50% 概率返回 503 错误,
> 模拟"评分服务调用失败"。但实际上 ratings 服务运转很正常(全部成功,延迟才 5ms)。

Verified independently:

```
$ # reviews-v2 → ratings, by response code
  reviews-v2 -> ratings  code=200  rate=0.730/s     ← every call succeeds
```

The downstream dependency is healthy. `reviews-v2` is generating the 503s
itself. This is the correct answer — Bookinfo's v2 image simulates a flaky
ratings call — and it is one layer past the intuitive one.

## Verification

Run afterwards, by hand, against the same Prometheus:

| Claim | Reported | Measured |
|---|---|---|
| reviews-v2 OK rate | 0.91/s | 0.842/s |
| reviews-v2 503 rate | 0.80/s | 0.814/s |
| reviews-v2 error share | ~47% | 49% |
| reviews-v3 | no errors | 1.782/s, all 200 |
| Total CPU | "under 1 core" | 1.04 cores |
| Network errors | 0 | 0 |
| reviews p99 latency | 9.9ms | 9.9ms |

Rates drift between scrapes; the shape and the conclusion hold.

## How it explained itself

Asked for a plain-language version:

> 就像一家餐厅,厨房(CPU/内存/网络)都运转正常,服务员(其他服务)也都没问题
> —— 但是帮您写评论的那个服务员经常说"我干不了",导致点评论功能时好时坏。
>
> *(Like a restaurant where the kitchen — CPU, memory, network — is running
> fine and the other waiters are fine, but the one waiter who writes your
> reviews keeps saying "I can't do it", so the review feature works
> intermittently.)*

Then three concrete steps, ordered by time-to-relief: an Istio retry policy as
a 5-minute stopgap, shifting traffic to v3, and fixing the v2 image as the
durable repair. It labelled the first two as mitigation rather than fixes.

## What it could not do

Asked to apply the fix, it declined, correctly:

> 系统里只配了监控(Prometheus)的连接,没有配管理集群的(Kubernetes/Ops)连接,
> 所以我没有权限也不具备条件去执行 kubectl 命令。

It then offered three alternatives, including configuring the Kubernetes
connector so it *could* act. It did not pretend, and it did not leave the user
stuck.

## The honest part

Things this run does not demonstrate:

- **It got the first answer wrong.** The initial report blamed the `ratings`
  dependency. It reached the right answer only when pushed to dig further. An
  on-call engineer who accepted the first report would have investigated the
  wrong service.
- **This is a synthetic fault.** Bookinfo's v2 is *designed* to fail this way.
  A real incident has fewer clean signals and more noise.
- **Metrics only.** No logs or Kubernetes connector were attached. The evidence
  gate requires two independent signal types and was satisfied with `metric`
  and `change` — but a real investigation is stronger with logs and events.
- **The evidence gate held it back, deliberately.** The final report was saved
  as `unresolved` rather than confirmed, because the referenced evidence did not
  meet the bar for a plan-backing root cause. That is the gate working: a
  plausible answer with thin evidence does not get to authorise a change.

## Reproducing this

The cluster is the standard Istio Bookinfo sample; the fault is built into the
`examples-bookinfo-reviews-v2` image. Any cluster running it with Istio
telemetry scraped by Prometheus will show the same 503 pattern.

```bash
kubectl apply -f https://raw.githubusercontent.com/istio/istio/master/samples/bookinfo/platform/kube/bookinfo.yaml
# point Rounds at your Prometheus, then ask:
#   "what is wrong with my system?"
```

If you run it and get a materially different result, that is worth an issue —
investigation quality is the product, and we would rather hear about a bad run
than not.
