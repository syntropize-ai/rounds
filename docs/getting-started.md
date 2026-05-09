# Getting Started

OpenObs is an **AI SRE** that lives next to your existing telemetry and operations tools. Get it running in under five minutes — no schema changes, no second copy of your data.

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

The setup wizard walks you through the minimum needed to start asking questions:

1. **Create your administrator account** (name, email, password — minimum 12 characters)
2. **Configure an LLM provider** — paste an Anthropic, OpenAI, or Gemini API key, point at a local Ollama server, or supply an `apiKeyHelper` script for short-lived / vault-issued credentials
3. **Add a metrics datasource** — Prometheus, VictoriaMetrics, Mimir, Thanos, Cortex, or any Prometheus-API-compatible backend
4. **Optionally add Loki** for log search and a **Kubernetes ops connector** so investigations can inspect pods, events, rollouts, and prepare approval-gated remediations

You don't have to do step 3 or 4 in the wizard — once OpenObs is running, you can also **add datasources, ops connectors, and low-risk org settings by chatting with the agent** ("connect my prod Prometheus at http://..."). The agent collects what it needs, previews the change, and applies it under your RBAC and the GuardedAction risk model.

## 3. Try a prompt

Once setup is complete, click the chat button and ask:

> *Create a dashboard for HTTP latency*

OpenObs will discover your metrics, build queries, validate them, and create a dashboard with overview stats, trend charts, and per-handler breakdowns — all grounded in your actual data.

Then try an investigation prompt:

> *Why is checkout latency high right now?*

If metrics, logs, and a Kubernetes connector are configured, OpenObs will query telemetry, inspect cluster state, write a report with citations on every claim, and recommend next actions. Mutating cluster actions are never executed silently:

- When **you** ask the agent to do something risky, it surfaces a **Run / Confirm / Apply** prompt inline in chat.
- When the agent is running **unattended** (auto-investigation triggered by a firing alert), the proposed fix is delivered as a `RemediationPlan` with formal **Approve / Reject / Modify** controls; the owning team / on-call is notified.

## Common first prompts

| Goal | Prompt |
|---|---|
| Build a dashboard | `Create a dashboard for checkout latency and errors` |
| Edit a dashboard | `Add p99 latency by route and remove panels with no data` |
| Understand a dashboard | `Explain what this dashboard tells me and what looks abnormal` |
| Create an alert | `Alert me when p95 latency is above 500ms for 10 minutes` |
| Investigate an alert | `Why did the high latency alert fire?` |
| Investigate the cluster | `Check whether Kubernetes is causing the latency spike` |

## What's next

- [Configuration](/configuration) — environment variables for production tuning
- [Chat & agents](/features/chat) — dashboard, alert, investigation, and remediation workflows
- [Authentication](/auth) — adding users, OAuth providers, role-based access control
- [API Reference](/api-reference) — automate via REST and service account tokens
