<h1 align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/public/rounds-logo-dark.svg" />
    <source media="(prefers-color-scheme: light)" srcset="docs/public/rounds-logo.svg" />
    <img src="docs/public/rounds-logo.svg" height="42" align="absmiddle" alt="" />
  </picture>
  &nbsp;Rounds
</h1>

<p align="center">
  <strong>The AI SRE your change-management process can accept.</strong><br />
  It cannot close an incident without evidence, and cannot touch production
  without an approval trail.<br />
  Open source, self-hosted, your own model.
</p>

<p align="center">
  <a href="https://github.com/syntropize-ai/rounds/actions/workflows/ci.yml"><img src="https://github.com/syntropize-ai/rounds/actions/workflows/ci.yml/badge.svg" alt="CI" /></a>
  <a href="https://github.com/syntropize-ai/rounds/blob/main/LICENSE"><img src="https://img.shields.io/github/license/syntropize-ai/rounds" alt="License" /></a>
  <a href="https://www.npmjs.com/package/@syntropize/rounds"><img src="https://img.shields.io/npm/v/@syntropize/rounds.svg?color=cb3837" alt="npm" /></a>
</p>

<p align="center">
  <a href="#quick-start">Quick Start</a> &middot;
  <a href="#what-can-it-do">What it does</a> &middot;
  <a href="#deploy-with-helm">Deploy</a> &middot;
  <a href="./docs">Docs</a>
</p>

---

Every pod reported `2/2 Running`. `kubectl` said the cluster was healthy.
47% of requests to one service were failing.

Asked *"what is wrong with my system?"*, Rounds found it in 83 seconds — and
showed its work:

```
Found: reviews service returns 503 on ~24% of requests (0.84/s, sustained)
       reviews-v2: 0.91 req/s OK + 0.80 req/s 503  (~47% error)
       reviews-v3: 1.72 req/s OK, no errors
       → v2 calls ratings, v3 does not — but ratings itself answers 200 at 5ms.
         The fault is inside v2, not in its dependency.

Ruled out, each with a query:
  ✗ CPU saturation      sum(rate(container_cpu_usage_seconds_total[5m])) → 0.66 cores
  ✗ Network failure     sum(rate(container_network_receive_errors_total[5m])) → 0
  ✗ Timeouts            histogram_quantile(0.99, ...) → p99 9.9ms
  ✗ Memory pressure     failures come from the load client, not reviews
```

Every number above was independently verified against Prometheus.
[Read the full investigation, including what it got wrong →](./docs/investigations/bookinfo-reviews-v2.md)

<p align="center">
  <a href="https://www.youtube.com/watch?v=sykQjRaLEN8">
    <img src="https://img.youtube.com/vi/sykQjRaLEN8/maxresdefault.jpg" width="760" alt="Rounds demo — watch on YouTube" />
  </a>
</p>
<p align="center"><sub>▶ <a href="https://www.youtube.com/watch?v=sykQjRaLEN8">Watch the 1-minute demo on YouTube</a></sub></p>

## Quick Start

You'll need a Kubernetes cluster and an API key for an LLM provider (Anthropic,
OpenAI, Gemini, DeepSeek, Azure OpenAI, or a local Ollama endpoint). Rounds
cannot investigate anything without a model, so have the key ready before you
start — the setup wizard asks for it and won't let you past that step.

```bash
helm install rounds oci://ghcr.io/syntropize-ai/charts/rounds \
  --namespace observability --create-namespace
```

The chart creates a private `ClusterIP` service. To open it locally:

```bash
kubectl -n observability port-forward svc/rounds 3000:80
```

Then open **http://127.0.0.1:3000**. The setup wizard walks through six steps:
create an admin account, paste your LLM key, and connect a datasource. The
connector and notification steps can be skipped and done later in Settings.

Once you're in, try:

- `Create a dashboard for HTTP latency`
- `Alert me when p95 latency is above 500ms for 10 minutes`
- `Why is checkout latency high right now?`

Questions about your own systems need a datasource connected — point Rounds at
your Prometheus in the wizard's Connectors step, or later under
Settings → Connectors.

For shared access, expose Rounds with Ingress or `service.type=LoadBalancer` — see [docs/install/kubernetes.md](./docs/install/kubernetes.md).

### Try it without a cluster

To see the product before committing to an install, the npm package runs the
same binary on a laptop with SQLite under `~/.rounds/`:

```bash
npx @syntropize/rounds
```

Then open **http://localhost:3000**. Single-node and unauthenticated by
default — fine for evaluation, not for production.

## Why this one

Plenty of tools will now investigate an incident for you. Three things here are
harder to find.

**Evidence, not vibes.** A root cause is only recorded as *resolved* when at
least two independent signal types support it, at least one competing
explanation was tested and recorded as ruled out, and a validation method is
named. Otherwise the report ships as `unresolved` with the next check to run —
and an unresolved investigation cannot back a remediation plan.

The server enforces this, and it also enforces that the evidence is real. The
two signal types have to be two reads that actually executed — metrics, logs,
Kubernetes state, change events — and the agent cannot make a third by labelling
one of them differently, or by citing a trace or a runbook it only described.
What is not yet verified is whether the stated result matches what the query
returned — see
[the risk model](./docs/reference/risk-model.md#what-the-evidence-gate-does-and-does-not-prove).

**Every production change leaves a paper trail.** Plan → attributed approval →
one audit row per step → paired rollback plan → post-execution verification
against the alert that triggered it. If your auditor asks who authorised a
change an AI made, at 3am, and how you knew it worked, that question has an
answer. See [change control](./docs/compliance/change-control.md).

**No SaaS in the middle.** Your cluster, your Prometheus, your LLM key. There is
no Rounds-operated service between you and your data, and no telemetry is sent
to us — there is nowhere for it to go.

Two things do leave, and you should know about both. Everything the agent reads
— metric values, log lines, command output — goes to whichever LLM endpoint you
configure; only a local one (Ollama, vLLM) keeps that inside your network.
Separately, the `web_search` tool queries DuckDuckGo, and those queries carry
your own service and metric names. Set `ROUNDS_DISABLE_WEB_SEARCH=true` to
remove it from the agent entirely. With that set and a local model, nothing
leaves.

Kubernetes is the first deep production workflow. Planned integrations include Prometheus alerting rules, Loki log routing, GitHub deploys, Jira / PagerDuty incident sync, CI/CD systems, and database read connectors — these are clearly marked as PLANNED in the docs and not promised by the current release.

### What it also does

Builds and edits dashboards from natural language, creates and tunes alert
rules with preview and backtest, and adds datasources through chat. These are
table stakes in 2026 — useful, but not why you would choose this.

## Deploy with Helm

```bash
helm install rounds oci://ghcr.io/syntropize-ai/charts/rounds \
  --namespace observability --create-namespace
```

### Storage

By default the chart runs SQLite on a PVC at `/var/lib/rounds/rounds.db`. That's fine for evaluation; for production set `secretEnv.DATABASE_URL` before first start so every Rounds repository uses Postgres:

```bash
helm install rounds oci://ghcr.io/syntropize-ai/charts/rounds \
  --namespace observability --create-namespace \
  --set-string secretEnv.DATABASE_URL='postgres://user:pass@host:5432/rounds'
```

Treat the database backend as an install-time choice — changing it later does not migrate existing data.

### Access

The default service is `ClusterIP`. Production deployments should front it with Ingress (`ingress.enabled=true`) or switch to `service.type=LoadBalancer`. Full options in [docs/install/kubernetes.md](./docs/install/kubernetes.md).

### Templating before install

```bash
helm template rounds ./helm/rounds   # render manifests locally
```

## Run without Kubernetes

See [Try it without a cluster](#try-it-without-a-cluster) above, or the
[npm install guide](./docs/install/npm.md) for persistent installs, upgrades,
and where data lives.

## Build from source

```bash
git clone https://github.com/syntropize-ai/rounds.git && cd rounds
npm install
npm run build
npm run start
```

## More

- [Documentation](./docs)
- [Getting started](./docs/getting-started.md)
- [Kubernetes install guide](./docs/install/kubernetes.md)
- [Architecture](./ARCHITECTURE.md)
- [Contributing](./CONTRIBUTING.md)

## License

[AGPL-3.0-or-later](./LICENSE) — Copyright (c) Syntropize.
