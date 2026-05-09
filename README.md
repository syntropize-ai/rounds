<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/public/openobs-logo.svg" />
    <source media="(prefers-color-scheme: light)" srcset="docs/public/openobs-logo-dark.svg" />
    <img src="docs/public/openobs-logo-dark.svg" width="80" height="80" alt="OpenObs logo" />
  </picture>
</p>

<h1 align="center">OpenObs</h1>

<p align="center">
  <strong>An open-source AI SRE.</strong><br />
  Build dashboards, create alerts, investigate incidents, and approve remediations from natural language.
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/openobs"><img src="https://img.shields.io/npm/v/openobs.svg?color=cb3837" alt="npm" /></a>
  <a href="https://github.com/openobs/openobs/actions/workflows/ci.yml"><img src="https://github.com/openobs/openobs/actions/workflows/ci.yml/badge.svg" alt="CI" /></a>
  <a href="https://github.com/openobs/openobs/blob/main/LICENSE"><img src="https://img.shields.io/github/license/openobs/openobs" alt="License" /></a>
  <a href="https://docs.openobs.com"><img src="https://img.shields.io/badge/docs-docs.openobs.com-blue" alt="Docs" /></a>
</p>

<p align="center">
  <a href="https://www.openobs.com">Website</a> &middot;
  <a href="https://docs.openobs.com">Documentation</a> &middot;
  <a href="#quick-start">Quick Start</a> &middot;
  <a href="#what-can-it-do">What it does</a> &middot;
  <a href="#deploy">Deploy</a>
</p>

---

<p align="center">
  <a href="https://www.youtube.com/watch?v=EbNIbS2uY3o">
    <img src="https://img.youtube.com/vi/EbNIbS2uY3o/maxresdefault.jpg" width="760" alt="OpenObs demo — watch on YouTube" />
  </a>
</p>
<p align="center"><sub>▶ <a href="https://www.youtube.com/watch?v=EbNIbS2uY3o">Watch the 1-minute demo on YouTube</a></sub></p>

## Quick Start

Install the latest release package:

```bash
npm install -g openobs
openobs
```

Then open **http://localhost:3000** and follow the setup wizard.

Try:

- `Create a dashboard for HTTP latency`
- `Alert me when p95 latency is above 500ms for 10 minutes`
- `Why is checkout latency high right now?`

## What can it do?

- **Observe** — create, edit, clone, explain, and delete dashboards from natural language.
- **Detect** — create and tune alert rules through chat, with preview and backtest before save.
- **Investigate** — correlate metrics, logs, recent changes, and (when connected) Kubernetes state, with citations on every claim.
- **Remediate safely** — propose fixes; user-driven actions confirm in chat (Run / Confirm / Apply), background-agent actions go through formal approval (Approve / Reject / Modify) with owner / on-call notification.
- **Configure by chat** — add datasources, ops connectors, and low-risk org settings through the agent (gated by RBAC and the GuardedAction risk model).

Kubernetes is the first deep production workflow. Planned integrations include Prometheus alerting rules, Loki log routing, GitHub deploys, Jira / PagerDuty incident sync, CI/CD systems, and database read connectors — these are clearly marked as PLANNED in the docs and not promised by the current release.

Learn more in the [docs](https://docs.openobs.com).

## Deploy

Install with Helm:

```bash
helm install openobs oci://ghcr.io/openobs/charts/openobs \
  --namespace observability --create-namespace
```

The default Helm install creates a private `ClusterIP` service. For a local
kind/minikube-style cluster, access it with:

```bash
kubectl -n observability port-forward svc/openobs 3000:80
```

Then open **http://127.0.0.1:3000** and complete the setup wizard. For shared
access, expose OpenObs with Ingress or `service.type=LoadBalancer`.

By default, npm uses a local SQLite database file under
`~/.openobs/openobs.db`. The Helm chart can also run that way on a PVC at
`/var/lib/openobs/openobs.db`, but production Kubernetes installs should set
`secretEnv.DATABASE_URL` before first start so every OpenObs repository uses
Postgres. Treat the database backend as an install-time choice: changing it
later does not migrate existing data.

See the [Kubernetes install guide](https://docs.openobs.com/install/kubernetes) for access, storage, and persistence options.

## Build from source

```bash
git clone https://github.com/openobs/openobs.git && cd openobs
npm install
npm run build
npm run start
```

## More

- [Documentation](https://docs.openobs.com)
- [Architecture](./ARCHITECTURE.md)
- [Contributing](./CONTRIBUTING.md)

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md) for development setup, code style, and where to put new code.

## License

[AGPL-3.0-or-later](./LICENSE)
