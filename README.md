<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/public/openobs-logo.svg" />
    <source media="(prefers-color-scheme: light)" srcset="docs/public/openobs-logo-dark.svg" />
    <img src="docs/public/openobs-logo-dark.svg" width="80" height="80" alt="OpenObs logo" />
  </picture>
</p>

<h1 align="center">OpenObs</h1>

<p align="center">
  <strong>An open-source AI SRE loop for modern operations.</strong><br />
  Build dashboards, create alerts, investigate incidents, and approve fixes from natural language.
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
- **Detect** — create and tune alert rules through chat.
- **Investigate** — use metrics, logs, recent changes, and Kubernetes context when configured.
- **Act safely** — recommend fixes and route mutating cluster actions through approval.

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

By default, npm and Helm both use a local SQLite database file. The npm package
stores it under `~/.openobs/openobs.db`; the Helm chart stores it on the chart's
PVC at `/var/lib/openobs/openobs.db`. Use an external Postgres database for
production or multi-replica Kubernetes deployments once full Postgres
persistence is enabled.

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

[MIT](./LICENSE)
