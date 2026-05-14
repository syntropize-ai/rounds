# Alert rules

Alert rules turn telemetry into operational signals. You can create and edit them from chat, or manage them from the **Alerts** page.

## Common tasks

- Create a rule: `Alert when checkout 5xx rate is above 1% for 5 minutes`.
- Change a threshold or duration from chat.
- Preview a rule before saving.
- Filter rules by state and severity.
- Investigate a firing alert.
- Open the related dashboard or remediation plan when one exists.
- Delete a rule with confirmation when your permissions allow it.

## Alerts page

Open **Alerts** from the sidebar. Use it to review current rules, firing state, severity, linked investigations, and available actions.

From a rule you can:

- edit expression, threshold, labels, severity, and folder;
- start an investigation;
- follow links to dashboards, plans, or reports;
- delete rules when allowed by RBAC.

## Chat workflow

Rounds uses the same connectors as dashboards. It finds candidate metrics, checks labels, validates the expression, and writes the rule only after the rule is clear enough to save.

Useful prompts:

> Warn when API p95 latency is above 800ms for 10 minutes.

> Make the ingress latency alert less noisy.

> Investigate why this alert fired last night.

## Permissions

Alert rules follow org, folder, and role permissions. Users without write access can still read or investigate alerts when their role allows it, but the agent will not receive write tools it cannot use.

## Limits

- Metric alerts are supported first.
- Notification routing is configured separately.
- Automatic investigation and remediation depend on the configured connectors, service accounts, and approval policy.
