# Getting Started

Get OpenObs running in under five minutes.

## 1. Install

Pick the install path that matches your environment:

::: code-group

```bash [npm (single machine)]
npx openobs
```

```bash [Helm (Kubernetes)]
helm upgrade --install openobs \
  oci://ghcr.io/openobs/charts/openobs \
  --namespace observability \
  --create-namespace \
  --set secretEnv.LLM_API_KEY='replace-with-your-provider-key'
```

:::

For more detail, see [Install with npm](/install/npm) or [Install with Helm](/install/kubernetes).

## 2. Open the web UI

The web UI runs on `http://localhost:5173` (npm install) or whatever Ingress / port-forward you configured for the Kubernetes deployment.

The setup wizard walks you through the first three steps:

1. **Create your administrator account** (name, email, password — minimum 12 characters)
2. **Configure an LLM provider** — paste an Anthropic, OpenAI, or Gemini API key, or point at a local Ollama server
3. **Add a datasource** — Prometheus, VictoriaMetrics, Loki, or any compatible backend

## 3. Try a prompt

Once setup is complete, click the chat button and ask:

> *Create a dashboard for HTTP latency*

OpenObs will discover your metrics, build queries, validate them, and create a dashboard with overview stats, trend charts, and per-handler breakdowns — all grounded in your actual data.

## What's next

- [Configuration](/configuration) — environment variables for production tuning
- [Authentication](/auth) — adding users, OAuth providers, role-based access control
- [API Reference](/api-reference) — automate via REST and service account tokens
