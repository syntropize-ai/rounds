<h1 align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/public/rounds-logo-dark.svg" />
    <source media="(prefers-color-scheme: light)" srcset="docs/public/rounds-logo.svg" />
    <img src="docs/public/rounds-logo.svg" height="42" align="absmiddle" alt="" />
  </picture>
  &nbsp;Rounds
</h1>

<p align="center">
  <strong>AI does rounds on your production.</strong><br />
  Self-hosted AI SRE — investigate incidents, build dashboards, manage alerts, and approve remediations from natural language.
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

## What can it do?

- **Observe** — create, edit, clone, explain, and delete dashboards from natural language.
- **Detect** — create and tune alert rules through chat, with preview and backtest before save.
- **Investigate** — correlate metrics, logs, recent changes, and (when connected) Kubernetes state, with citations on every claim.
- **Remediate safely** — propose fixes; user-driven actions confirm in chat (Run / Confirm / Apply), background-agent actions go through formal approval (Approve / Reject / Modify) with owner / on-call notification.
- **Configure by chat** — add datasources, ops connectors, and low-risk org settings through the agent (gated by RBAC and the GuardedAction risk model).

Kubernetes is the first deep production workflow. Planned integrations include Prometheus alerting rules, Loki log routing, GitHub deploys, Jira / PagerDuty incident sync, CI/CD systems, and database read connectors — these are clearly marked as PLANNED in the docs and not promised by the current release.

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
