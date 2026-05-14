# Connectors

Connectors let Rounds read telemetry and, when approved, act on operational systems. Dashboards, alerts, investigations, and chat all use the same connector inventory.

## Connector types

| Type | Status | Used for |
|---|---|---|
| Prometheus-compatible metrics | Supported | Dashboards, alerts, investigations |
| Loki logs | Supported | Log search and investigations |
| Kubernetes | Supported | Cluster inspection and approval-gated remediation |
| Manual change events | Supported | Investigation correlation |
| Notifications | Supported by configuration | Alert and approval delivery |
| GitHub, Jira, PagerDuty, CI/CD, tracing, database reads | Planned | Change sync, incident sync, deeper investigations |

Prometheus-compatible systems include Prometheus, Mimir, Thanos, Cortex, VictoriaMetrics, and similar APIs.

## Add a connector

Use **Setup Wizard → Connectors** during first run, or **Settings → Connectors** after setup.

You can also ask chat when your role allows connector changes:

> Connect my dev Prometheus at localhost:9090

Rounds validates the endpoint, saves non-secret configuration, and asks you to add credentials in Settings when needed.

## Connector behavior

- Connectors are org-scoped.
- Credentials are stored as secrets, not shown back in the UI.
- The agent chooses a connector by signal type and default status.
- If multiple connectors match, the agent can ask you to choose.
- Sensitive connector operations are controlled by RBAC and policy.

## Settings page

Open **Settings → Connectors** to view configured connectors, status, capabilities, and policy controls.

Open **Settings → AI** to set the LLM provider used by chat, investigations, and generation workflows.

Open **Settings → Notifications** to configure delivery channels.

## Limits

- Metrics and logs are read through their source APIs; Rounds does not copy your full telemetry store.
- Kubernetes write actions require explicit approval.
- Some connector creation and policy editing surfaces are still being expanded in the UI.
